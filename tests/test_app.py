import io
import re

import pytest
from openpyxl import Workbook
from sqlalchemy import select

from app import jan
from app.db import SessionLocal
from app.models import Location, Product, Stock

JAN_A = "4900000000016"  # seeded: 品番 A-001 / 商品A
JAN_B = "4900000000023"
JAN_C = "4900000000030"
JAN_D = "4900000000047"


def qty(code, loc_name):
    with SessionLocal() as db:
        return db.scalar(
            select(Stock.quantity).join(Stock.product).join(Stock.location)
            .where(Product.jan == code, Location.name == loc_name)
        )


def loc_id(name):
    with SessionLocal() as db:
        return db.scalar(select(Location.id).where(Location.name == name))


def prod(code):
    with SessionLocal() as db:
        return db.scalar(select(Product).where(Product.jan == code))


def move(client, kind, quantity, loc="東京倉庫", code=JAN_A, on=None):
    """在庫の増減（直接入力は廃止したので、サービス層を直接呼ぶ）。"""
    from app import services
    from app.models import MovementKind

    with SessionLocal() as db:
        product = db.scalar(select(Product).where(Product.jan == code))
        location = db.scalar(select(Location).where(Location.name == loc))
        services.apply_movement(db, product=product, location=location, kind=MovementKind(kind),
                                quantity=quantity, on=on)
        db.commit()


# ---- JAN -----------------------------------------------------------------------

@pytest.mark.parametrize("value,expected", [
    ("4912345678904", "4912345678904"),
    (4912345678904, "4912345678904"),
    (4912345678904.0, "4912345678904"),
    ("４９１２３４５６７８９０４", "4912345678904"),
    ("49000016", "49000016"),
    ("012345678905", "0012345678905"),  # 先頭の0が落ちた12桁
])
def test_jan_normalize(value, expected):
    assert jan.normalize(value) == expected


@pytest.mark.parametrize("value", ["4912345678905", "12345", "4.91235E+12", "ABC", ""])
def test_jan_invalid(value):
    with pytest.raises(jan.JanError):
        jan.normalize(value)


# ---- 画面 ----------------------------------------------------------------------

def test_pages_render(seeded):
    move(seeded, "IN", 1)
    for path in ["/", "/stocks", "/stocks?view=location", "/products", "/locations", "/movements",
                 "/imports", f"/products/{prod(JAN_A).id}", f"/locations/{loc_id('東京倉庫')}",
                 f"/locations/{loc_id('北京委託店')}"]:
        assert seeded.get(path).status_code == 200, path


def test_product_create_validates_jan(seeded):
    r = seeded.post("/products", data={"jan": "4900000000017", "name": "x"})
    assert "チェックデジット" in r.text
    r = seeded.post("/products", data={"jan": JAN_A, "name": "dup"})
    assert "すでに登録" in r.text
    seeded.post("/products", data={"jan": "４９０００００００００２３", "name": "商品B"})
    assert prod(JAN_B).name == "商品B"


def test_home_redirects_to_stocks_and_stock_views(seeded):
    move(seeded, "IN", 10)
    move(seeded, "IN", 7, loc="北京委託店")
    assert seeded.get("/").url.path == "/stocks"
    by_loc = seeded.get("/stocks", params={"view": "location", "region": "CN"}).text
    assert "<td>北京委託店</td>" in by_loc and "<td>東京倉庫</td>" not in by_loc
    by_product = seeded.get("/stocks").text
    assert JAN_A in by_product and "<b>17</b>" in by_product


def test_pagination(seeded):
    from app.jan import check_digit

    with SessionLocal() as db:
        for i in range(120):
            body = f"490100{i:06d}"
            db.add(Product(jan=body + str(check_digit(body)), name=f"商品{i:03d}"))
        db.commit()
    html = seeded.get("/products").text
    assert "121件中 1–50件" in html
    assert "121件中 101–121件" in seeded.get("/products", params={"page": 3}).text


# ---- 商品マスタ取込 -------------------------------------------------------------------

def xlsx(rows, title_rows=0):
    wb = Workbook()
    ws = wb.active
    for _ in range(title_rows):
        ws.append(["タイトル"])
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_product_master_import(seeded):
    data = xlsx([
        ["JANコード", "商品名", "品番", "単位"],
        [int(JAN_B), "商品B", "B-002", "箱"],      # 数値セルのJAN
        [JAN_A, "商品A（改）", None, None],          # 既存 → 更新（空欄は上書きしない）
        ["4900000000031", "不正", None, None],     # チェックデジット誤り
    ])
    r = seeded.post("/products/import", files={"file": ("m.xlsx", data)})
    assert "新規 1件、更新 1件" in r.text and "エラー 1件" in r.text
    assert prod(JAN_B).unit == "箱"
    a = prod(JAN_A)
    assert a.name == "商品A（改）" and a.sku == "A-001"


def test_product_master_template_roundtrip(seeded):
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(seeded.get("/products/template.xlsx").content))
    ws = wb["商品マスタ"]
    assert [c.value for c in ws[1]][:7] == ["JANコード", "商品名", "ブランド", "上代（税込）", "品番", "単位", "備考"]
    assert ws["A2"].number_format == "@"
    ws["A2"], ws["B2"], ws["C2"], ws["D2"], ws["F2"] = JAN_B, "商品B", "Studio Haneul", 1650, "箱"
    ws["A3"], ws["B3"] = JAN_C, "商品C"
    buf = io.BytesIO()
    wb.save(buf)
    r = seeded.post("/products/import", files={"file": ("master.xlsx", buf.getvalue())})
    assert "新規 2件" in r.text and "エラー" not in r.text
    b = prod(JAN_B)
    assert (b.unit, b.brand, b.price) == ("箱", "Studio Haneul", 1650) and prod(JAN_C).name == "商品C"


# ---- 在庫取込 --------------------------------------------------------------------

def upload(client, filename, data, kind="IN", location=None):
    r = client.post("/imports", data={"kind": kind, "location_id": loc_id(location) if location else ""},
                    files={"file": (filename, data)})
    assert r.status_code == 200
    m = re.search(r"/imports/(\d+)$", str(r.url))
    assert m, r.url
    return int(m.group(1)), r.text


def test_excel_import_with_new_product_and_location_column(seeded):
    data = xlsx([
        ["JANコード", "商品名", "数量", "拠点"],
        [JAN_A, "商品A", "１２", "上海倉庫"],
        [JAN_B, "商品B", 5, None],
        [JAN_B, "商品B", 3, None],
        [JAN_C, "商品C", 1, "存在しない店"],
        [JAN_D, None, 1, None],                     # 未登録・商品名なし
        ["4900000000048", "誤り", 1, None],          # チェックデジット誤り
        ["合計", None, 21, None],
    ], title_rows=2)
    batch_id, html = upload(seeded, "in.xlsx", data, location="東京倉庫")
    assert "新規商品" in html and "存在しない店" in html and "チェックデジット" in html
    r = seeded.post(f"/imports/{batch_id}/apply")
    assert "3件を反映しました" in r.text
    assert qty(JAN_A, "上海倉庫") == 12
    assert qty(JAN_B, "東京倉庫") == 8
    assert prod(JAN_C) is None and prod(JAN_D) is None
    seeded.post(f"/imports/{batch_id}/apply")  # 二重反映されない
    assert qty(JAN_B, "東京倉庫") == 8


def test_import_by_sku_only(seeded):
    data = xlsx([["品番", "数量"], ["A-001", 6], ["Z-999", 1]])
    batch_id, html = upload(seeded, "sku.xlsx", data, location="東京倉庫")
    assert "品番「Z-999」の商品は未登録です" in html
    seeded.post(f"/imports/{batch_id}/apply")
    assert qty(JAN_A, "東京倉庫") == 6


def test_csv_import_chinese_headers_set(seeded):
    move(seeded, "IN", 50, loc="北京委託店")
    csv_bytes = f"条码,品名,库存\n{JAN_A},商品A,30\n".encode("gb18030")
    batch_id, _ = upload(seeded, "count.csv", csv_bytes, kind="SET", location="北京委託店")
    seeded.post(f"/imports/{batch_id}/apply")
    assert qty(JAN_A, "北京委託店") == 30


def test_import_out_flags_insufficient_stock(seeded):
    move(seeded, "IN", 3)
    data = xlsx([["JAN", "販売数"], [JAN_A, 2], [JAN_A, 2]])
    batch_id, html = upload(seeded, "out.xlsx", data, kind="OUT", location="東京倉庫")
    assert "在庫不足" in html
    seeded.post(f"/imports/{batch_id}/apply")
    assert qty(JAN_A, "東京倉庫") == 1


def make_pdf(table_rows):
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4)
    t = Table(table_rows)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, "black")]))
    doc.build([t])
    return buf.getvalue()


def test_pdf_import_table(seeded):
    data = make_pdf([["JAN", "Item", "Qty"], [JAN_A, "Item A", "7"], [JAN_D, "Item D", "2"]])
    batch_id, _ = upload(seeded, "slip.pdf", data, location="大阪委託店")
    seeded.post(f"/imports/{batch_id}/apply")
    assert qty(JAN_A, "大阪委託店") == 7
    assert qty(JAN_D, "大阪委託店") == 2


def test_exports_and_templates(seeded):
    move(seeded, "IN", 1)
    for path in ["/stocks/export.xlsx", "/stocks/export.xlsx?view=location", "/imports/template.xlsx",
                 "/products/template.xlsx"]:
        r = seeded.get(path)
        assert r.status_code == 200 and r.content[:2] == b"PK", path


def test_unsupported_file(seeded):
    r = seeded.post("/imports", data={"kind": "IN"}, files={"file": ("a.txt", b"x")})
    assert "対応形式" in r.text


def test_store_report(seeded):
    from datetime import date

    seeded.post("/products", data={"jan": JAN_B, "name": "商品B", "brand": "Lovely MongMong", "price": "1,650"})
    # 納品（日付別）→ 販売 → 残数報告（在庫更新）
    data = xlsx([["JANコード", "商品名", "ブランド", "上代（税込）", "数量"],
                 [JAN_A, "商品A", "Studio Haneul", 330, 20], [JAN_B, "商品B", None, None, 10]])
    r = seeded.post("/imports", data={"kind": "IN", "location_id": loc_id("大阪委託店"), "on": "2025-09-26"},
                    files={"file": ("d1.xlsx", data)})
    seeded.post(r.url.path + "/apply")
    data = xlsx([["JAN", "納品数"], [JAN_A, 10]])
    r = seeded.post("/imports", data={"kind": "IN", "location_id": loc_id("大阪委託店"), "on": "2025-11-09"},
                    files={"file": ("d2.xlsx", data)})
    seeded.post(r.url.path + "/apply")
    data = xlsx([["JAN", "販売数"], [JAN_A, 12], [JAN_B, 4]])
    r = seeded.post("/imports", data={"kind": "OUT", "location_id": loc_id("大阪委託店"), "on": "2026-09-30"},
                    files={"file": ("s.xlsx", data)})
    seeded.post(r.url.path + "/apply")
    data = xlsx([["JAN", "残数"], [JAN_A, 17]])
    r = seeded.post("/imports", data={"kind": "SET", "location_id": loc_id("大阪委託店"), "on": "2026-09-30"},
                    files={"file": ("z.xlsx", data)})
    seeded.post(r.url.path + "/apply")

    a = prod(JAN_A)
    assert (a.brand, a.price) == ("Studio Haneul", 330)  # 取込ファイルからマスタの空欄を補完

    from app import services
    with SessionLocal() as db:
        loc = db.get(Location, loc_id("大阪委託店"))
        rep = services.store_report(db, loc)
        rows = {r.product.jan: r for r in rep.rows}
        assert rep.delivery_dates == [date(2025, 9, 26), date(2025, 11, 9)]
        ra = rows[JAN_A]
        assert (ra.delivered, ra.sold, ra.adjusted, ra.stock) == (30, 12, -1, 17)
        assert ra.deliveries == {date(2025, 9, 26): 20, date(2025, 11, 9): 10}
        assert ra.sell_through == 12 / (12 + 17) and ra.sales_amount == 12 * 330
        assert rows[JAN_B].sales_amount == 4 * 1650
        assert rep.brands == ["Lovely MongMong", "Studio Haneul"]
        assert [r.product.jan for r in services.store_report(db, loc, brand="Lovely MongMong").rows] == [JAN_B]

    html = seeded.get(f"/locations/{loc_id('大阪委託店')}").text
    assert "25/09/26" in html and "41%" in html and "Lovely MongMong" in html
    x = seeded.get(f"/locations/{loc_id('大阪委託店')}/export.xlsx")
    assert x.status_code == 200 and x.content[:2] == b"PK"


def test_zero_missing_on_full_stock_update(seeded):
    seeded.post("/products", data={"jan": JAN_B, "name": "商品B"})
    move(seeded, "IN", 5, loc="大阪委託店")
    move(seeded, "IN", 3, loc="大阪委託店", code=JAN_B)
    move(seeded, "IN", 9, loc="東京倉庫", code=JAN_B)
    data = xlsx([["JAN", "在庫数"], [JAN_A, 4]])
    r = seeded.post("/imports", data={"kind": "SET", "location_id": loc_id("大阪委託店"), "zero_missing": "1"},
                    files={"file": ("all.xlsx", data)})
    assert "1件の在庫を0にします" in r.text
    r = seeded.post(r.url.path + "/apply")
    assert "ファイルにない 1件を0にしました" in r.text
    assert qty(JAN_A, "大阪委託店") == 4 and qty(JAN_B, "大阪委託店") == 0
    assert qty(JAN_B, "東京倉庫") == 9  # 他の拠点は変わらない


def test_products_without_jan(seeded):
    # 商品マスタ: JAN 空欄でも商品名で登録・更新できる
    data = xlsx([["JANコード", "商品名", "ブランド", "上代（税込）"],
                 [None, "ふわふわぬいぐるみ", "Studio Haneul", 500],
                 [None, "ふわふわぬいぐるみ", None, 550]])
    r = seeded.post("/products/import", files={"file": ("m.xlsx", data)})
    assert "新規 1件" in r.text and "エラー" not in r.text
    with SessionLocal() as db:
        p = db.scalar(select(Product).where(Product.name == "ふわふわぬいぐるみ"))
        assert p.jan is None and p.price == 550 and p.brand == "Studio Haneul"

    # 在庫取込: JAN なし行は商品名で照合。未登録の商品名は JAN なしで新規登録
    data = xlsx([["JANコード", "商品名", "数量"], [None, "ふわふわぬいぐるみ", 87], [None, "フロッキーマスコット", 12],
                 [None, "合計", 99]])
    batch_id, html = upload(seeded, "nojan.xlsx", data, location="大阪委託店")
    assert "JANなし" in html and "合計" not in html.split("<tbody>")[1]
    seeded.post(f"/imports/{batch_id}/apply")
    with SessionLocal() as db:
        names = {s.product.name: s.quantity for s in db.scalars(select(Stock)).all()}
        assert names == {"ふわふわぬいぐるみ": 87, "フロッキーマスコット": 12}

    # 画面からも JAN なしで登録できる（同名の JAN なし商品は重複不可）
    r = seeded.post("/products", data={"jan": "", "name": "ベイビーキーホルダー"})
    assert "登録しました" in r.text
    r = seeded.post("/products", data={"jan": "", "name": "ベイビーキーホルダー"})
    assert "すでに登録" in r.text
    for path in ["/products", "/stocks", "/stocks?view=location", f"/locations/{loc_id('大阪委託店')}"]:
        assert seeded.get(path).status_code == 200
