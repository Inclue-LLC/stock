import io
from datetime import date
from pathlib import Path
from urllib.parse import urlencode

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import importers, oz_import, services, xlsx_templates
from . import jan as jancode
from .models import (
    ImportBatch,
    Location,
    LocationType,
    MovementKind,
    Product,
    Region,
    Source,
    today_jst,
)
from .services import StockError
from .store import DuplicateError, Store, request_lock, store

APP_DIR = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

app = FastAPI(title="在庫管理")
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
templates = Jinja2Templates(directory=APP_DIR / "templates")
templates.env.globals.update(Region=Region, LocationType=LocationType, MovementKind=MovementKind)


@app.middleware("http")
async def no_index(request: Request, call_next):
    """リンクを知っている人だけが使う前提なので、検索エンジンに載せない。"""
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


def get_store():
    """1リクエストずつ順番に処理する（メモリ上のデータの整合性を保つため）。"""
    with request_lock:
        yield store


@app.get("/robots.txt", response_class=PlainTextResponse)
def robots():
    return "User-agent: *\nDisallow: /\n"


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"


def render(request: Request, name: str, **ctx):
    def url_with(**changes):
        params = {k: v for k, v in request.query_params.items() if k not in ("page", "msg", "error")}
        params.update(changes)
        params = {k: v for k, v in params.items() if v not in (None, "")}
        return "?" + urlencode(params) if params else request.url.path

    ctx.setdefault("url_with", url_with)
    ctx.setdefault("path", request.url.path)
    ctx.setdefault("msg", request.query_params.get("msg"))
    ctx.setdefault("error", request.query_params.get("error"))
    return templates.TemplateResponse(request, name, ctx)


def redirect(path: str, **params) -> RedirectResponse:
    params = {k: v for k, v in params.items() if v}
    return RedirectResponse(f"{path}?{urlencode(params)}" if params else path, status_code=303)


def enum_or_none(enum_cls, value: str | None):
    try:
        return enum_cls(value) if value else None
    except ValueError:
        return None


def int_or_none(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None


def parse_date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def page_param(request: Request) -> int:
    return int_or_none(request.query_params.get("page")) or 1


def xlsx_response(wb, filename: str) -> StreamingResponse:
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


def found(obj):
    if obj is None:
        raise HTTPException(404)
    return obj


def read_upload(file: UploadFile) -> bytes | None:
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    return None if len(data) > MAX_UPLOAD_BYTES else data


@app.get("/")
def home():
    return RedirectResponse("/stocks", status_code=307)


# ---- 在庫一覧 -------------------------------------------------------------------

def _stock_filters(request: Request):
    p = request.query_params
    return dict(
        region=enum_or_none(Region, p.get("region")),
        ltype=enum_or_none(LocationType, p.get("type")),
        location_id=p.get("location_id") or None,
        q=(p.get("q") or "").strip(),
        include_zero=p.get("include_zero") == "1",
    )


@app.get("/stocks")
def stock_list(request: Request, st: Store = Depends(get_store)):
    filters = _stock_filters(request)
    view = "location" if request.query_params.get("view") == "location" else "product"
    if view == "product":
        items = services.product_totals(st, filters["q"], only_in_stock=not filters["include_zero"])
    else:
        items = services.stock_rows(st, **filters)
    return render(
        request, "stocks.html",
        view=view, page=services.paginate(items, page_param(request), per_page=100), filters=filters,
        locations=st.all_locations(), categories=services.CATEGORIES, export_query=request.url.query,
    )


@app.get("/stocks/export.xlsx")
def stock_export(request: Request, st: Store = Depends(get_store)):
    from openpyxl import Workbook

    filters = _stock_filters(request)
    wb = Workbook()
    ws = wb.active
    ws.title = "在庫"
    if request.query_params.get("view") == "location":
        ws.append(["JANコード", "品番", "商品名", "地域", "種別", "拠点", "数量", "単位"])
        for s in services.stock_rows(st, **filters):
            ws.append([s.product.jan, s.product.sku, s.product.name, s.location.region.label,
                       s.location.type.label, s.location.name, s.quantity, s.product.unit])
    else:
        ws.append(["JANコード", "品番", "商品名"]
                  + [f"{r.label}・{t.label}" for r, t in services.CATEGORIES] + ["合計", "単位"])
        for p, *qtys in services.product_totals(st, filters["q"], not filters["include_zero"]):
            ws.append([p.jan, p.sku, p.name, *qtys, p.unit])
    for col in ws.iter_cols(min_col=1, max_col=1):
        for c in col:
            c.number_format = "@"  # JAN を文字列として扱う
    return xlsx_response(wb, "stock.xlsx")


# ---- 拠点 ----------------------------------------------------------------------

@app.get("/locations")
def location_list(request: Request, st: Store = Depends(get_store)):
    totals: dict[str, int] = {}
    for s in st.all_stocks():
        totals[s.location.id] = totals.get(s.location.id, 0) + s.quantity
    return render(request, "locations.html", locations=st.all_locations(), totals=totals)


def _store_report(request: Request, st: Store, location: Location):
    p = request.query_params
    return services.store_report(st, location, brand=p.get("brand", ""), q=(p.get("q") or "").strip())


@app.get("/locations/{location_id}")
def location_detail(request: Request, location_id: str, st: Store = Depends(get_store)):
    location = found(st.location(location_id))
    return render(request, "location_detail.html", location=location, report=_store_report(request, st, location),
                  last_updated=location.updated_at,
                  brand=request.query_params.get("brand", ""), q=request.query_params.get("q", ""),
                  show_dates=request.query_params.get("dates") != "0")


@app.get("/locations/{location_id}/export.xlsx")
def location_export(request: Request, location_id: str, st: Store = Depends(get_store)):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    location = found(st.location(location_id))
    report = _store_report(request, st, location)
    wb = Workbook()
    ws = wb.active
    ws.title = location.name[:31]
    dates = report.delivery_dates
    ws.append(["ブランド", "商品名", "JANコード", "上代（税込）"]
              + [f"{d:%y/%m/%d} 納品" for d in dates]
              + ["納品数 合計", "販売数", "在庫更新差分", "在庫数", "消化率（販売÷(販売+在庫)）", "販売金額（上代）",
                 "在庫金額（上代）"])
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="1F4E9E")
    for r in report.rows:
        ws.append([r.product.brand, r.product.name, r.product.jan, r.product.price]
                  + [r.deliveries.get(d) for d in dates]
                  + [r.delivered, r.sold, r.adjusted or None, r.stock, r.sell_through,
                     r.sales_amount, r.stock_amount])
    last_col = ws.max_column
    for row in ws.iter_rows(min_row=2):
        row[2].number_format = "@"
        row[last_col - 3].number_format = "0.0%"
        for c in (row[3], row[last_col - 2], row[last_col - 1]):
            c.number_format = "#,##0"
    ws.freeze_panes = "C2"
    for col, width in zip("ABCD", (18, 40, 16, 12)):
        ws.column_dimensions[col].width = width
    return xlsx_response(wb, "store_report.xlsx")


@app.post("/locations")
def location_create(
    name: str = Form(...), region: Region = Form(...), type: LocationType = Form(...),
    note: str = Form(""), st: Store = Depends(get_store),
):
    name = name.strip()
    if not name:
        return redirect("/locations", error="拠点名を入力してください")
    try:
        with st.writing():
            st.save_location(Location(name=name, region=region, type=type, note=note))
    except DuplicateError as e:
        return redirect("/locations", error=str(e))
    return redirect("/locations", msg=f"拠点「{name}」を登録しました")


@app.post("/locations/{location_id}")
def location_update(
    location_id: str, name: str = Form(...), region: Region = Form(...), type: LocationType = Form(...),
    note: str = Form(""), st: Store = Depends(get_store),
):
    loc = found(st.location(location_id))
    if not name.strip():
        return redirect("/locations", error="拠点名を入力してください")
    try:
        with st.writing():
            loc.name, loc.region, loc.type, loc.note = name.strip(), region, type, note
            st.save_location(loc)
    except DuplicateError as e:  # writing() がメモリの変更を破棄する
        return redirect("/locations", error=str(e))
    return redirect("/locations", msg="拠点を更新しました")


@app.post("/locations/{location_id}/delete")
def location_delete(location_id: str, st: Store = Depends(get_store)):
    loc = found(st.location(location_id))
    if st.has_movements(location_id=loc.id):
        return redirect("/locations", error="入出庫履歴がある拠点は削除できません")
    with st.writing():
        st.delete_location(loc)
    return redirect("/locations", msg="拠点を削除しました")


# ---- 商品 ----------------------------------------------------------------------

@app.get("/products")
def product_list(request: Request, q: str = "", st: Store = Depends(get_store)):
    totals: dict[str, int] = {}
    for s in st.all_stocks():
        totals[s.product.id] = totals.get(s.product.id, 0) + s.quantity
    items = [(p, totals.get(p.id, 0)) for p in st.all_products() if services.matches(p, q)]
    brands = sorted({p.brand for p in st.all_products() if p.brand})
    return render(request, "products.html", page=services.paginate(items, page_param(request), per_page=50), q=q,
                  brands=brands, prefill_jan=request.query_params.get("jan", ""))


def price_or_none(value: str) -> int | None:
    return importers.parse_quantity(value) if value.strip() else None


@app.post("/products")
def product_create(
    jan: str = Form(""), name: str = Form(...), sku: str = Form(""), unit: str = Form("個"),
    brand: str = Form(""), price: str = Form(""), note: str = Form(""), st: Store = Depends(get_store),
):
    code, err = jancode.try_normalize(jan) if jan.strip() else (None, None)
    if err:
        return redirect("/products", error=err, jan=jan)
    name = name.strip()
    if not name:
        return redirect("/products", error="商品名を入力してください", jan=jan)
    if code is None and st.products_by_name(name, jan_none_only=True):
        return redirect("/products", error=f"JANなしの商品「{name}」はすでに登録されています")
    try:
        with st.writing():
            st.save_product(Product(jan=code, name=name, sku=sku.strip(), unit=unit.strip() or "個", note=note,
                                    brand=brand.strip(), price=price_or_none(price)))
    except DuplicateError as e:
        return redirect("/products", error=str(e))
    return redirect("/products", msg=f"商品「{name}」を登録しました")


@app.post("/products/import")
def product_import(file: UploadFile = File(...), st: Store = Depends(get_store)):
    data = read_upload(file)
    if data is None:
        return redirect("/products", error="ファイルサイズが大きすぎます（上限20MB）")
    try:
        parsed = importers.parse_product_file(file.filename or "", data)
    except ValueError as e:
        return redirect("/products", error=str(e))
    except Exception:
        return redirect("/products", error="ファイルを読み込めませんでした。形式を確認してください")
    if not parsed.rows:
        return redirect("/products", error=" / ".join(parsed.warnings) or "商品が見つかりませんでした")
    with st.writing():
        result = services.import_products(st, parsed.rows)
    msg = f"商品マスタを取り込みました：新規 {result.created}件、更新 {result.updated}件"
    error = None
    if result.errors:
        shown = result.errors[:10]
        more = f" ほか{len(result.errors) - 10}件" if len(result.errors) > 10 else ""
        error = f"エラー {len(result.errors)}件（取り込まれていません）: " + " / ".join(shown) + more
    return redirect("/products", msg=msg, error=error)


@app.get("/products/template.xlsx")
def product_template():
    return xlsx_response(xlsx_templates.product_master_workbook(), "product_master.xlsx")


@app.get("/products/{product_id}")
def product_detail(request: Request, product_id: str, st: Store = Depends(get_store)):
    product = found(st.product(product_id))
    lorder = {loc.id: i for i, loc in enumerate(st.all_locations())}
    stocks = sorted(st.stocks_for_product(product.id), key=lambda s: lorder.get(s.location.id, 0))
    movements, _ = st.movements(product_id=product.id, limit=100)
    movements.sort(key=lambda m: (m.business_date, m.created_at), reverse=True)
    return render(request, "product_detail.html", product=product, stocks=stocks, movements=movements,
                  total=sum(s.quantity for s in stocks))


@app.post("/products/{product_id}")
def product_update(
    product_id: str, jan: str = Form(""), name: str = Form(...), sku: str = Form(""), unit: str = Form("個"),
    brand: str = Form(""), price: str = Form(""), note: str = Form(""), st: Store = Depends(get_store),
):
    product = found(st.product(product_id))
    code, err = jancode.try_normalize(jan) if jan.strip() else (None, None)
    if err:
        return redirect(f"/products/{product_id}", error=err)
    if not name.strip():
        return redirect(f"/products/{product_id}", error="商品名を入力してください")
    if code and (dup := st.product_by_jan(code)) is not None and dup.id != product.id:
        return redirect(f"/products/{product_id}", error=f"JANコード「{code}」はすでに使われています")
    with st.writing():
        product.jan, product.sku, product.name = code, sku.strip(), name.strip()
        product.unit, product.note = unit.strip() or "個", note
        product.brand, product.price = brand.strip(), price_or_none(price)
        st.save_product(product)
    return redirect(f"/products/{product_id}", msg="商品を更新しました")


@app.post("/products/{product_id}/delete")
def product_delete(product_id: str, st: Store = Depends(get_store)):
    product = found(st.product(product_id))
    if st.has_movements(product_id=product.id):
        return redirect(f"/products/{product_id}", error="入出庫履歴がある商品は削除できません")
    with st.writing():
        st.delete_product(product)
    return redirect("/products", msg="商品を削除しました")


# ---- 入出庫履歴 -------------------------------------------------------------------

@app.get("/movements")
def movement_list(request: Request, st: Store = Depends(get_store)):
    p = request.query_params
    region = enum_or_none(Region, p.get("region"))
    ltype = enum_or_none(LocationType, p.get("type"))
    location_id = p.get("location_id") or None
    source = enum_or_none(Source, p.get("source"))
    batch_id = p.get("batch_id") or None
    q = (p.get("q") or "").strip()
    items, truncated = st.movements(location_id=location_id, batch_id=batch_id)
    items = [
        m for m in items
        if (not region or m.location.region == region) and (not ltype or m.location.type == ltype)
        and (not source or m.source == source) and services.matches(m.product, q)
    ]
    return render(request, "movements.html", page=services.paginate(items, page_param(request), per_page=100),
                  locations=st.all_locations(), truncated=truncated,
                  filters=dict(region=region, ltype=ltype, location_id=location_id, source=source, q=q,
                               batch_id=batch_id),
                  Source=Source)


# ---- ファイル取込（Excel / CSV / PDF） ---------------------------------------------

IMPORT_KINDS = (MovementKind.SET, MovementKind.IN, MovementKind.OUT)


@app.get("/imports")
def import_index(request: Request, st: Store = Depends(get_store)):
    return render(request, "imports.html", batches=st.batches(), locations=st.all_locations(), kinds=IMPORT_KINDS,
                  selected_location=request.query_params.get("location_id"),
                  selected_kind=request.query_params.get("kind") or "SET", today=today_jst().isoformat())


@app.get("/imports/oz")
def oz_import_form(request: Request):
    return render(request, "oz_import.html", result=None)


@app.post("/imports/oz")
def oz_import_run(request: Request, file: UploadFile = File(...), mode: str = Form("check"),
                  st: Store = Depends(get_store)):
    from openpyxl import load_workbook

    data = read_upload(file)
    if data is None:
        return redirect("/imports/oz", error="ファイルサイズが大きすぎます（上限20MB）")
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True)
        result = oz_import.run(st, wb, dry_run=(mode != "save"))
    except ValueError as e:
        return redirect("/imports/oz", error=str(e))
    except KeyError as e:
        return redirect("/imports/oz", error=f"シート {e} が見つかりません。OZ納品数集計のファイルを選んでください")
    return render(request, "oz_import.html", result=result, filename=file.filename)


@app.get("/imports/template.xlsx")
def import_template():
    return xlsx_response(xlsx_templates.stock_import_workbook(), "stock_import_template.xlsx")


@app.post("/imports")
def import_upload(
    file: UploadFile = File(...),
    kind: str = Form(...),
    location_id: str = Form(""),
    zero_missing: str = Form(""),
    on: str = Form(""),
    st: Store = Depends(get_store),
):
    mk = enum_or_none(MovementKind, kind)
    if mk not in IMPORT_KINDS:
        return redirect("/imports", error="区分が不正です")
    data = read_upload(file)
    if data is None:
        return redirect("/imports", error="ファイルサイズが大きすぎます（上限20MB）")
    filename = file.filename or "upload"
    try:
        source, parsed = importers.parse_file(filename, data)
    except ValueError as e:
        return redirect("/imports", error=str(e))
    except Exception:
        return redirect("/imports", error="ファイルを読み込めませんでした。形式を確認してください")
    location = found(st.location(location_id)) if location_id else None
    batch = ImportBatch(filename=filename, source=Source(source), kind=mk, location=location,
                        rows=parsed.rows, warnings=parsed.warnings,
                        zero_missing=(mk == MovementKind.SET and zero_missing == "1"),
                        date=parse_date(on) or today_jst())
    with st.writing():
        st.save_batch(batch)
    return redirect(f"/imports/{batch.id}")


@app.get("/imports/{batch_id}")
def import_preview(request: Request, batch_id: str, st: Store = Depends(get_store)):
    batch = found(st.batch(batch_id))
    preview = services.validate_batch(st, batch) if batch.status == "pending" else []
    missing = services.missing_stocks(st, batch, preview) if preview else []
    return render(
        request, "import_preview.html", batch=batch, preview=preview, locations=st.all_locations(),
        missing=missing,
        ok_count=sum(1 for p in preview if not p["errors"]),
        new_products=sum(1 for p in preview if not p["errors"] and p["product"] is None),
    )


@app.post("/imports/{batch_id}/location")
def import_set_location(batch_id: str, location_id: str = Form(""), st: Store = Depends(get_store)):
    batch = found(st.batch(batch_id))
    if batch.status == "pending":
        batch.location = st.location(location_id)
        with st.writing():
            st.save_batch(batch)
    return redirect(f"/imports/{batch_id}")


@app.post("/imports/{batch_id}/apply")
def import_apply(batch_id: str, st: Store = Depends(get_store)):
    batch = found(st.batch(batch_id))
    try:
        with st.writing():
            applied, skipped, zeroed = services.apply_batch(st, batch)
    except StockError as e:
        return redirect(f"/imports/{batch_id}", error=str(e))
    msg = f"{applied}件を反映しました" + (f"（エラー {skipped}件はスキップ）" if skipped else "")
    if zeroed:
        msg += f"。ファイルにない {zeroed}件を0にしました"
    return redirect(f"/imports/{batch_id}", msg=msg)


@app.post("/imports/{batch_id}/cancel")
def import_cancel(batch_id: str, st: Store = Depends(get_store)):
    batch = found(st.batch(batch_id))
    if batch.status == "pending":
        batch.status = "cancelled"
        with st.writing():
            st.save_batch(batch)
    return redirect("/imports", msg="取込を取り消しました")
