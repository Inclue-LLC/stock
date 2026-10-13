import io
import re

from openpyxl import Workbook
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Location, Product, Stock


def qty(sku, loc_name):
    with SessionLocal() as db:
        return db.scalar(
            select(Stock.quantity).join(Stock.product).join(Stock.location)
            .where(Product.sku == sku, Location.name == loc_name)
        )


def loc_id(name):
    with SessionLocal() as db:
        return db.scalar(select(Location.id).where(Location.name == name))


def prod_id(sku):
    with SessionLocal() as db:
        return db.scalar(select(Product.id).where(Product.sku == sku))


def move(client, kind, quantity, loc="東京倉庫", **extra):
    return client.post("/movements", data={
        "kind": kind, "product_id": prod_id("A-001"), "location_id": loc_id(loc), "quantity": quantity, **extra,
    })


def test_pages_render(seeded):
    for path in ["/", "/stocks", "/products", "/locations", "/movements", "/movements/new", "/imports",
                 f"/products/{prod_id('A-001')}"]:
        assert seeded.get(path).status_code == 200, path


def test_manual_in_out_set_transfer(seeded):
    move(seeded, "IN", 10)
    assert qty("A-001", "東京倉庫") == 10
    move(seeded, "OUT", 3)
    assert qty("A-001", "東京倉庫") == 7
    move(seeded, "TRANSFER", 5, to_location_id=loc_id("大阪委託店"))
    assert qty("A-001", "東京倉庫") == 2
    assert qty("A-001", "大阪委託店") == 5
    move(seeded, "SET", 4, loc="大阪委託店")
    assert qty("A-001", "大阪委託店") == 4


def test_out_more_than_stock_is_rejected(seeded):
    move(seeded, "IN", 2)
    r = move(seeded, "OUT", 5)
    assert "在庫が不足" in r.text
    assert qty("A-001", "東京倉庫") == 2


def test_dashboard_matrix(seeded):
    move(seeded, "IN", 10)
    move(seeded, "IN", 7, loc="北京委託店")
    html = seeded.get("/").text
    assert ">10<" in html and ">7<" in html
    stocks = seeded.get("/stocks", params={"region": "CN"}).text
    assert "<td>北京委託店</td>" in stocks and "<td>東京倉庫</td>" not in stocks


def make_xlsx(rows):
    wb = Workbook()
    ws = wb.active
    ws.append(["入庫伝票"])  # header is not on row 1
    ws.append([])
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def upload(client, filename, data, kind="IN", location=None):
    r = client.post("/imports", data={"kind": kind, "location_id": loc_id(location) if location else ""},
                    files={"file": (filename, data)})
    assert r.status_code == 200
    m = re.search(r"/imports/(\d+)$", str(r.url))
    assert m, r.url
    return int(m.group(1)), r.text


def test_excel_import_with_new_product_and_location_column(seeded):
    data = make_xlsx([
        ["品番", "商品名", "数量", "拠点"],
        ["A-001", "商品A", "１２", "上海倉庫"],
        ["B-002", "商品B", 5, None],
        ["B-002", "商品B", 3, None],
        ["C-003", "商品C", 1, "存在しない店"],
        ["合計", None, 21, None],
    ])
    batch_id, html = upload(seeded, "in.xlsx", data, location="東京倉庫")
    assert "新規商品として登録" in html
    assert "存在しない店" in html
    r = seeded.post(f"/imports/{batch_id}/apply")
    assert "3件を反映しました" in r.text
    assert qty("A-001", "上海倉庫") == 12
    assert qty("B-002", "東京倉庫") == 8
    assert prod_id("C-003") is None
    # second apply is refused
    r = seeded.post(f"/imports/{batch_id}/apply")
    assert qty("B-002", "東京倉庫") == 8


def test_csv_import_chinese_headers_cp932_set(seeded):
    move(seeded, "IN", 50, loc="北京委託店")
    csv_bytes = "货号,品名,库存\nA-001,商品A,30\n".encode("gb18030")
    batch_id, _ = upload(seeded, "count.csv", csv_bytes, kind="SET", location="北京委託店")
    seeded.post(f"/imports/{batch_id}/apply")
    assert qty("A-001", "北京委託店") == 30


def test_import_out_flags_insufficient_stock(seeded):
    move(seeded, "IN", 3)
    data = make_xlsx([["品番", "数量"], ["A-001", 2], ["A-001", 2]])
    batch_id, html = upload(seeded, "out.xlsx", data, kind="OUT", location="東京倉庫")
    assert "在庫不足" in html
    seeded.post(f"/imports/{batch_id}/apply")
    assert qty("A-001", "東京倉庫") == 1


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
    data = make_pdf([["SKU", "Item", "Qty"], ["A-001", "Item A", "7"], ["D-004", "Item D", "2"]])
    batch_id, html = upload(seeded, "slip.pdf", data, location="大阪委託店")
    seeded.post(f"/imports/{batch_id}/apply")
    assert qty("A-001", "大阪委託店") == 7
    assert qty("D-004", "大阪委託店") == 2


def test_export_and_template(seeded):
    move(seeded, "IN", 1)
    r = seeded.get("/stocks/export.xlsx")
    assert r.status_code == 200 and r.content[:2] == b"PK"
    assert seeded.get("/imports/template.xlsx").content[:2] == b"PK"


def test_unsupported_file(seeded):
    r = seeded.post("/imports", data={"kind": "IN"}, files={"file": ("a.txt", b"x")})
    assert "対応形式" in r.text
