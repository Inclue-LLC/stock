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


def move(client, kind, quantity, loc="東京倉庫", code=JAN_A, **extra):
    return client.post("/movements", data={
        "kind": kind, "code": code, "location_id": loc_id(loc), "quantity": quantity, **extra,
    })


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
                 "/movements/new", "/imports", f"/products/{prod(JAN_A).id}"]:
        assert seeded.get(path).status_code == 200, path


def test_product_create_validates_jan(seeded):
    r = seeded.post("/products", data={"jan": "4900000000017", "name": "x"})
    assert "チェックデジット" in r.text
    r = seeded.post("/products", data={"jan": JAN_A, "name": "dup"})
    assert "すでに登録" in r.text
    seeded.post("/products", data={"jan": "４９０００００００００２３", "name": "商品B"})
    assert prod(JAN_B).name == "商品B"


def test_lookup_api(seeded):
    move(seeded, "IN", 4)
    r = seeded.get("/api/products/lookup", params={"code": JAN_A}).json()
    assert r["name"] == "商品A" and r["stocks"][str(loc_id("東京倉庫"))] == 4
    assert seeded.get("/api/products/lookup", params={"code": "A-001"}).json()["jan"] == JAN_A
    assert seeded.get("/api/products/lookup", params={"code": JAN_B}).status_code == 404
    assert seeded.get("/api/products/search", params={"q": "商品"}).json()[0]["jan"] == JAN_A


# ---- 直接入力 --------------------------------------------------------------------

def test_manual_in_out_set_transfer(seeded):
    move(seeded, "IN", 10)
    assert qty(JAN_A, "東京倉庫") == 10
    move(seeded, "OUT", 3, code="A-001")  # 品番でも指定できる
    assert qty(JAN_A, "東京倉庫") == 7
    move(seeded, "TRANSFER", 5, to_location_id=loc_id("大阪委託店"))
    assert qty(JAN_A, "東京倉庫") == 2
    assert qty(JAN_A, "大阪委託店") == 5
    move(seeded, "SET", 4, loc="大阪委託店")
    assert qty(JAN_A, "大阪委託店") == 4


def test_manual_unknown_jan(seeded):
    r = move(seeded, "IN", 1, code=JAN_B)
    assert "未登録" in r.text


def test_out_more_than_stock_is_rejected(seeded):
    move(seeded, "IN", 2)
    r = move(seeded, "OUT", 5)
    assert "在庫が不足" in r.text
    assert qty(JAN_A, "東京倉庫") == 2


def test_dashboard_and_stock_views(seeded):
    move(seeded, "IN", 10)
    move(seeded, "IN", 7, loc="北京委託店")
    html = seeded.get("/").text
    assert "17" in html
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
    assert "JANコードが必要" in html
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
    data = xlsx([["JAN", "数量"], [JAN_A, 2], [JAN_A, 2]])
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
