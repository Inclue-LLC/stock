import math
from dataclasses import dataclass, field
from datetime import date

from . import jan as jancode
from .models import (
    ImportBatch,
    Location,
    LocationType,
    Movement,
    MovementKind,
    Product,
    Region,
    Source,
    Stock,
    now_jst,
)
from .store import Store


class StockError(ValueError):
    pass


def compute_delta(kind: MovementKind, current: int, quantity: int) -> int:
    if quantity < 0:
        raise StockError("数量は0以上で入力してください")
    if kind in (MovementKind.IN, MovementKind.TRANSFER_IN):
        return quantity
    if kind in (MovementKind.OUT, MovementKind.TRANSFER_OUT):
        return -quantity
    if kind == MovementKind.SET:
        return quantity - current
    raise StockError(f"不明な区分: {kind}")


def apply_movement(
    st: Store,
    *,
    product: Product,
    location: Location,
    kind: MovementKind,
    quantity: int,
    source: Source = Source.MANUAL,
    batch: ImportBatch | None = None,
    note: str = "",
    on: date | None = None,
) -> Movement:
    """在庫を増減し、履歴と店舗別明細用の累計（納品・販売・調整）を更新する。st.writing() の中で呼ぶ。"""
    stock = st.stock(product.id, location.id)
    current = stock.quantity if stock else 0
    delta = compute_delta(kind, current, quantity)
    new_qty = current + delta
    if new_qty < 0:
        raise StockError(
            f"{product.name}（{location.name}）の在庫が不足しています: 現在 {current}、出庫 {quantity}"
        )
    stock = st.get_or_create_stock(product, location)
    stock.quantity = new_qty
    if kind in (MovementKind.IN, MovementKind.TRANSFER_IN):
        d = on or now_jst().date()
        stock.deliveries[d] = stock.deliveries.get(d, 0) + delta
        stock.delivered += delta
    elif kind in (MovementKind.OUT, MovementKind.TRANSFER_OUT):
        stock.sold += -delta
    else:
        stock.adjusted += delta
    st.save_stock(stock)
    location.updated_at = now_jst()
    st.save_location(location)
    return st.add_movement(Movement(
        product=product, location=location, kind=kind, delta=delta, quantity_after=new_qty, source=source,
        batch_id=batch.id if batch else None, note=note, date=on,
    ))


def get_current_qty(st: Store, product_id: str, location_id: str) -> int:
    s = st.stock(product_id, location_id)
    return s.quantity if s else 0


# ---- 一覧・検索 -------------------------------------------------------------------

def matches(product: Product, q: str) -> bool:
    """JAN（前方一致）・品番・商品名（部分一致）で絞り込む。"""
    q = (q or "").strip()
    if not q:
        return True
    ql = q.lower()
    return (product.jan or "").startswith(q) or ql in (product.sku or "").lower() or ql in product.name.lower()


def stock_rows(st: Store, *, region: Region | None = None, ltype: LocationType | None = None,
               location_id: str | None = None, q: str = "", include_zero: bool = False) -> list[Stock]:
    rorder = {r: i for i, r in enumerate(Region)}
    torder = {t: i for i, t in enumerate(LocationType)}
    rows = [
        s for s in st.all_stocks()
        if (not region or s.location.region == region) and (not ltype or s.location.type == ltype)
        and (not location_id or s.location.id == location_id) and matches(s.product, q)
        and (include_zero or s.quantity != 0)
    ]
    rows.sort(key=lambda s: (s.product.name, s.product.jan or "", rorder[s.location.region],
                             torder[s.location.type], s.location.name))
    return rows


CATEGORIES = [(r, t) for r in Region for t in LocationType]


def product_totals(st: Store, q: str = "", only_in_stock: bool = False) -> list[tuple]:
    """商品ごとに (商品, 地域×種別の4区分..., 合計) の在庫数を集計する。"""
    sums: dict[str, dict] = {}
    for s in st.all_stocks():
        sums.setdefault(s.product.id, {}).setdefault((s.location.region, s.location.type), 0)
        sums[s.product.id][(s.location.region, s.location.type)] += s.quantity
    rows = []
    for p in st.all_products():
        if not matches(p, q):
            continue
        cats = [sums.get(p.id, {}).get(c, 0) for c in CATEGORIES]
        total = sum(cats)
        if only_in_stock and total == 0:
            continue
        rows.append((p, *cats, total))
    return rows


def product_total(st: Store, product_id: str) -> int:
    return sum(s.quantity for s in st.stocks_for_product(product_id))


@dataclass
class Page:
    items: list
    page: int
    per_page: int
    total: int

    @property
    def pages(self) -> int:
        return max(1, math.ceil(self.total / self.per_page))

    @property
    def start(self) -> int:
        return 0 if self.total == 0 else (self.page - 1) * self.per_page + 1

    @property
    def end(self) -> int:
        return min(self.total, self.page * self.per_page)


def paginate(items: list, page: int, per_page: int = 50) -> Page:
    total = len(items)
    page = max(1, min(page, max(1, math.ceil(total / per_page))))
    return Page(items=items[(page - 1) * per_page:page * per_page], page=page, per_page=per_page, total=total)


# ---- 商品の特定 -------------------------------------------------------------------

def find_product_by_name(st: Store, name: str) -> tuple[Product | None, str | None]:
    """JAN のない商品を商品名で探す。戻り値: (商品, エラー)。"""
    found = st.products_by_name(name)
    if len(found) > 1:
        return None, f"商品名「{name}」の商品が複数あります。JANコードで指定してください"
    return (found[0] if found else None), None


def find_product(st: Store, jan: str = "", sku: str = "", name: str = ""
                 ) -> tuple[Product | None, str | None, str | None]:
    """JAN → 品番 → 商品名（JANなし商品）の順に商品を探す。戻り値: (商品, 正規化済みJAN, エラー)。

    JAN が正しい形式で未登録の場合は (None, jan, None)、
    JAN・品番がなく商品名が未登録の場合は (None, None, None) を返す（どちらも新規登録可能）。
    """
    if jan:
        code, err = jancode.try_normalize(jan)
        if err:
            return None, None, err
        return st.product_by_jan(code), code, None
    if sku:
        found = st.products_by_sku(sku)
        if len(found) == 1:
            return found[0], found[0].jan, None
        if len(found) > 1:
            return None, None, f"品番「{sku}」の商品が複数あります。JANコードで指定してください"
        if not name:
            return None, None, f"品番「{sku}」の商品は未登録です"
    if name:
        product, err = find_product_by_name(st, name)
        return product, (product.jan if product else None), err
    return None, None, "JANコード・品番・商品名のいずれも読み取れません"


# ---- 商品マスタ取込 -----------------------------------------------------------------

@dataclass
class ProductImportResult:
    created: int = 0
    updated: int = 0
    errors: list[str] = field(default_factory=list)


def import_products(st: Store, rows: list[dict]) -> ProductImportResult:
    """JAN をキーに商品を新規登録 / 更新する（空欄の項目は上書きしない）。st.writing() の中で呼ぶ。"""
    result = ProductImportResult()
    seen: dict[str, Product] = {}
    for i, row in enumerate(rows, start=1):
        if row.get("jan"):
            code, err = jancode.try_normalize(row["jan"])
            if err:
                result.errors.append(f"{i}件目: {err}")
                continue
            key = code
            product = seen.get(key) or st.product_by_jan(code)
        else:  # JAN なし商品は商品名で識別
            if not row.get("name"):
                continue
            code, key = None, "name:" + row["name"]
            product, err = (seen.get(key), None) if key in seen else find_product_by_name(st, row["name"])
            if err:
                result.errors.append(f"{i}件目: {err}")
                continue
        if product is None:
            if not row.get("name"):
                result.errors.append(f"{i}件目: JAN {code} の商品名がありません")
                continue
            product = Product(jan=code, name=row["name"])
            result.created += 1
        elif key not in seen:
            result.updated += 1
        for field_name in ("name", "sku", "unit", "note", "brand"):
            if row.get(field_name):
                setattr(product, field_name, row[field_name])
        if row.get("price") is not None:
            product.price = row["price"]
        st.save_product(product)
        seen[key] = product
    return result


# ---- 在庫取込（ImportBatch） --------------------------------------------------------

def resolve_location(st: Store, name: str | None, default: Location | None) -> Location | None:
    if name:
        return st.location_by_name(name)
    return default


def validate_batch(st: Store, batch: ImportBatch) -> list[dict]:
    """各行に product/location の解決結果とエラーを付けたプレビュー用リストを返す。"""
    preview = []
    pending: dict[tuple[str, str], int] = {}  # 同一ファイル内の累積（出庫時の在庫チェック用）
    for i, row in enumerate(batch.rows):
        item = dict(row, index=i, errors=[], product=None, location=None, current=None, after=None,
                    location_name=row.get("location"), jan_code=None)
        product, code, err = find_product(st, row.get("jan") or "", row.get("sku") or "", row.get("name") or "")
        item["product"], item["jan_code"] = product, code
        # 同一ファイル内で同じ商品を指す行をまとめるためのキー
        item["key"] = f"id:{product.id}" if product else (code or f"name:{row.get('name') or ''}")
        if err:
            item["errors"].append(err)
        elif product is None and not row.get("name"):
            item["errors"].append("未登録のJANで、商品名がありません")
        loc = resolve_location(st, row.get("location"), batch.location)
        item["location"] = loc
        if loc is None:
            item["errors"].append(
                f"拠点「{row.get('location')}」が見つかりません" if row.get("location") else "拠点が未指定です"
            )
        if row.get("quantity") is None:
            item["errors"].append("数量が読み取れません")
        if loc is not None and not err and row.get("quantity") is not None:
            key = (item["key"], loc.id)
            if key in pending:
                current = pending[key]
            elif product is not None:
                current = get_current_qty(st, product.id, loc.id)
            else:
                current = 0
            try:
                after = current + compute_delta(batch.kind, current, row["quantity"])
            except StockError as e:
                item["errors"].append(str(e))
            else:
                if after < 0:
                    item["errors"].append(f"在庫不足（現在 {current}）")
                item["current"], item["after"] = current, after
                if not item["errors"]:
                    pending[key] = after
        preview.append(item)
    return preview


def missing_stocks(st: Store, batch: ImportBatch, preview: list[dict]) -> list[Stock]:
    """在庫更新で「ファイルにない商品を0にする」とき、0にされる在庫。

    対象は、ファイル内で正常に読めた行の拠点のみ。
    """
    if not (batch.zero_missing and batch.kind == MovementKind.SET):
        return []
    in_file: dict[str, set[str]] = {}
    for item in preview:
        if not item["errors"]:
            ids = in_file.setdefault(item["location"].id, set())
            if item["product"] is not None:
                ids.add(item["product"].id)
    stocks = [s for s in st.all_stocks()
              if s.location.id in in_file and s.quantity != 0 and s.product.id not in in_file[s.location.id]]
    return sorted(stocks, key=lambda s: (s.location.name, s.product.name))


def apply_batch(st: Store, batch: ImportBatch, *, skip_errors: bool = True) -> tuple[int, int, int]:
    """取込を確定する。戻り値は (反映件数, スキップ件数, 0にした件数)。st.writing() の中で呼ぶ。"""
    if batch.status != "pending":
        raise StockError("この取込はすでに処理済みです")
    applied = skipped = 0
    created: dict[str, Product] = {}  # 同一ファイル内で新規登録した商品
    preview = validate_batch(st, batch)
    missing = missing_stocks(st, batch, preview)
    for item in preview:
        if item["errors"]:
            if not skip_errors:
                raise StockError(f"{item['index'] + 1}行目: {' / '.join(item['errors'])}")
            skipped += 1
            continue
        product = item["product"] or created.get(item["key"])
        if product is None:
            product = st.save_product(Product(
                jan=item["jan_code"], sku=item.get("sku") or "", name=item["name"], unit=item.get("unit") or "個",
                brand=item.get("brand") or "", price=item.get("price")))
            created[item["key"]] = product
        elif (not product.brand and item.get("brand")) or (product.price is None and item.get("price") is not None):
            # マスタの空欄（ブランド・上代）はファイルの値で補う
            product.brand = product.brand or item.get("brand") or ""
            if product.price is None:
                product.price = item.get("price")
            st.save_product(product)
        apply_movement(st, product=product, location=item["location"], kind=batch.kind,
                       quantity=item["quantity"], source=batch.source, batch=batch,
                       note=item.get("note") or batch.filename, on=batch.date)
        applied += 1
    for stock in missing:
        apply_movement(st, product=stock.product, location=stock.location, kind=MovementKind.SET, quantity=0,
                       source=batch.source, batch=batch, note=f"{batch.filename} に記載なし", on=batch.date)
    batch.status = "applied"
    st.save_batch(batch)
    return applied, skipped, len(missing)


# ---- 拠点（店舗）別レポート ------------------------------------------------------------

@dataclass
class StoreRow:
    product: Product
    deliveries: dict  # 納品日 → 数量
    delivered: int = 0
    sold: int = 0
    adjusted: int = 0  # 在庫更新による差分（ロス・棚差など）
    stock: int = 0

    @property
    def sell_through(self) -> float | None:
        """消化率 = 販売数 ÷（販売数 ＋ 在庫数）。納品記録が欠けていても 100% を超えない。"""
        base = self.sold + max(self.stock, 0)
        return self.sold / base if base else None

    @property
    def sales_amount(self) -> int | None:
        return self.sold * self.product.price if self.product.price is not None else None

    @property
    def stock_amount(self) -> int | None:
        return self.stock * self.product.price if self.product.price is not None else None


@dataclass
class StoreReport:
    rows: list[StoreRow]
    delivery_dates: list[date]
    brands: list[str]

    def total(self, attr: str) -> int:
        return sum(getattr(r, attr) or 0 for r in self.rows)

    def delivery_total(self, d: date) -> int:
        return sum(r.deliveries.get(d, 0) for r in self.rows)

    @property
    def sell_through(self) -> float | None:
        sold = self.total("sold")
        base = sold + sum(max(r.stock, 0) for r in self.rows)
        return sold / base if base else None


def store_report(st: Store, location: Location, brand: str = "", q: str = "") -> StoreReport:
    """拠点ごとに、商品別の 納品（日付別）・販売・在庫更新差分・現在庫 を集計する。"""
    all_rows = [
        StoreRow(product=s.product, deliveries=dict(s.deliveries), delivered=s.delivered, sold=s.sold,
                 adjusted=s.adjusted, stock=s.quantity)
        for s in st.stocks_for_location(location.id)
    ]
    brands = sorted({r.product.brand for r in all_rows if r.product.brand})
    dates = sorted({d for r in all_rows for d, q_ in r.deliveries.items() if q_})
    rows = [r for r in all_rows if (not brand or r.product.brand == brand) and matches(r.product, q)]
    rows.sort(key=lambda r: (r.product.brand or "￿", r.product.name))
    return StoreReport(rows=rows, delivery_dates=dates, brands=brands)
