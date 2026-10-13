"""Excel / CSV / PDF から明細（JAN・品番・商品名・数量・拠点）を読み取る。

ヘッダー行は先頭付近から自動検出する。日本語・中国語・英語の列名に対応。
"""

import csv
import io
import re
import unicodedata
from dataclasses import dataclass, field

HEADER_ALIASES: dict[str, list[str]] = {
    "jan": ["jan", "janコード", "jancode", "jan code", "バーコード", "ean", "ean13", "ean code", "barcode",
            "条码", "条形码", "商品条码", "国际条码"],
    "sku": ["sku", "品番", "商品コード", "商品番号", "型番", "品目コード", "コード",
            "item code", "itemcode", "code", "货号", "商品编码", "编码", "编号", "产品编号"],
    "name": ["商品名", "品名", "品目", "品目名", "名称", "製品名", "item", "name", "product", "description",
             "商品名称", "产品名称", "品名称"],
    "quantity": ["数量", "個数", "在庫数", "在庫", "入庫数", "出庫数", "販売数", "売上数", "販売点数", "納品数",
                 "納品数量", "入荷数", "出荷数", "残数", "残数量", "月末在庫", "期末在庫", "実在庫", "実在庫数",
                 "qty", "quantity", "count", "数", "库存", "库存数量", "入库数量", "出库数量", "销售数量", "销量"],
    "location": ["拠点", "倉庫", "店舗", "保管場所", "委託先", "location", "warehouse", "store", "仓库", "门店", "店铺"],
    "unit": ["単位", "unit", "单位"],
    "brand": ["ブランド", "brand", "メーカー", "品牌"],
    "price": ["上代", "上代（税込）", "上代(税込)", "上代税込", "売価", "売価（税込）", "定価", "販売価格", "価格",
              "price", "retail price", "零售价", "售价"],
    "note": ["備考", "メモ", "note", "remarks", "备注"],
}

# どの列があれば取込対象の表とみなすか（タプル内はいずれか1つ）
STOCK_REQUIRED = (("jan", "sku", "name"), ("quantity",))
PRODUCT_REQUIRED = (("jan",), ("name",))
HEADER_SCAN_ROWS = 30


def normalize(text) -> str:
    if text is None:
        return ""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text))).lower()


_ALIAS_LOOKUP = {normalize(a): key for key, aliases in HEADER_ALIASES.items() for a in aliases}


def parse_quantity(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if float(value).is_integer() else None
    s = normalize(value).replace(",", "")
    m = re.fullmatch(r"(-?\d+(?:\.0+)?)[^\d]*", s)
    if not m:
        return None
    return int(float(m.group(1)))


@dataclass
class ParseResult:
    rows: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def match_header(cells: list, required=STOCK_REQUIRED) -> dict[str, int] | None:
    mapping: dict[str, int] = {}
    for idx, cell in enumerate(cells):
        key = _ALIAS_LOOKUP.get(normalize(cell))
        if key and key not in mapping:
            mapping[key] = idx
    if all(any(k in mapping for k in group) for group in required):
        return mapping
    return None


def code_str(value) -> str:
    """Excel の数値セル（4901234567894.0 など）も含めてコードを文字列にする。"""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return unicodedata.normalize("NFKC", str(value)).strip()


def rows_from_table(table: list[list], result: ParseResult, label: str = "", required=STOCK_REQUIRED) -> bool:
    """2次元配列からヘッダーを検出して明細行を抽出する。ヘッダーが見つかれば True。"""
    header_idx = mapping = None
    for i, cells in enumerate(table[:HEADER_SCAN_ROWS]):
        mapping = match_header(list(cells), required)
        if mapping:
            header_idx = i
            break
    if mapping is None:
        return False

    def cell(cells, key):
        idx = mapping.get(key)
        if idx is None or idx >= len(cells):
            return None
        v = cells[idx]
        return v.strip() if isinstance(v, str) else v

    for offset, cells in enumerate(table[header_idx + 1:], start=header_idx + 2):
        cells = list(cells)
        jan = code_str(cell(cells, "jan"))
        sku = code_str(cell(cells, "sku"))
        name = cell(cells, "name")
        raw_qty = cell(cells, "quantity")
        qty = parse_quantity(raw_qty)
        if normalize(jan or sku or name) in ("合計", "小計", "total", "合计", "小计"):
            continue
        if not jan and not sku:
            # JAN・品番のない行は、商品名があり（在庫ファイルなら数量も）ある場合だけ JAN なし商品として扱う
            if name in (None, "") or ("quantity" in mapping and qty is None):
                continue
        if "quantity" in mapping and qty is None:
            result.warnings.append(f"{label}{offset}行目: 数量「{raw_qty}」を読み取れません")
        location = cell(cells, "location")
        result.rows.append({
            "jan": jan,
            "sku": sku,
            "name": str(name) if name not in (None, "") else "",
            "quantity": qty,
            "location": str(location) if location not in (None, "") else None,
            "unit": str(cell(cells, "unit") or ""),
            "brand": str(cell(cells, "brand") or ""),
            "price": parse_quantity(cell(cells, "price")),
            "note": str(cell(cells, "note") or ""),
        })
    return True


def parse_excel(data: bytes, required=STOCK_REQUIRED) -> ParseResult:
    from openpyxl import load_workbook

    result = ParseResult()
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    found = False
    for ws in wb.worksheets:
        table = [list(r) for r in ws.iter_rows(values_only=True)]
        label = f"[{ws.title}] " if len(wb.worksheets) > 1 else ""
        if rows_from_table(table, result, label, required):
            found = True
    if not found:
        result.warnings.append(header_missing(required))
    return result


def header_missing(required) -> str:
    if required is PRODUCT_REQUIRED:
        return "見出し行（JANコード・商品名）が見つかりませんでした"
    return "見出し行（JANコード または 品番、数量）が見つかりませんでした"


def parse_csv(data: bytes, required=STOCK_REQUIRED) -> ParseResult:
    for enc in ("utf-8-sig", "cp932", "gb18030"):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        return ParseResult(warnings=["文字コードを判別できませんでした"])
    result = ParseResult()
    table = list(csv.reader(io.StringIO(text)))
    if not rows_from_table(table, result, required=required):
        result.warnings.append(header_missing(required))
    return result


# 表として抽出できない PDF 用: 「JAN(または品番) 商品名 数量」の並びの行を拾う
_LINE_RE = re.compile(r"^(?P<code>[A-Za-z0-9][\w\-./]*)\s+(?P<name>.+?)\s+(?P<qty>-?\d[\d,]*)\s*\S{0,3}$")


def parse_pdf(data: bytes) -> ParseResult:
    import pdfplumber

    result = ParseResult()
    found = False
    lines: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for pno, page in enumerate(pdf.pages, start=1):
            for table in page.extract_tables():
                if rows_from_table(table, result, f"p{pno} "):
                    found = True
            lines.extend((page.extract_text() or "").splitlines())
    if found:
        return result

    for line in lines:
        m = _LINE_RE.match(unicodedata.normalize("NFKC", line).strip())
        if m:
            code = m["code"]
            is_jan = re.fullmatch(r"\d{8}|\d{13}", code) is not None
            result.rows.append({
                "jan": code if is_jan else "", "sku": "" if is_jan else code, "name": m["name"].strip(), "quantity": parse_quantity(m["qty"]),
                "location": None, "unit": "", "note": "",
            })
    if result.rows:
        result.warnings.append("PDF内に表が見つからなかったため、テキスト行から推定しました。内容を必ず確認してください")
    else:
        result.warnings.append("PDFから明細を読み取れませんでした（スキャン画像のPDFは非対応です）")
    return result


def parse_file(filename: str, data: bytes) -> tuple[str, ParseResult]:
    """在庫明細の読み取り。戻り値: (Source の値, ParseResult)"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in ("xlsx", "xlsm"):
        return "EXCEL", parse_excel(data)
    if ext == "csv":
        return "CSV", parse_csv(data)
    if ext == "pdf":
        return "PDF", parse_pdf(data)
    raise ValueError("対応形式は .xlsx / .xlsm / .csv / .pdf です")


def parse_product_file(filename: str, data: bytes) -> ParseResult:
    """商品マスタ（JANコード・商品名・品番・単位）の読み取り。"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in ("xlsx", "xlsm"):
        return parse_excel(data, PRODUCT_REQUIRED)
    if ext == "csv":
        return parse_csv(data, PRODUCT_REQUIRED)
    raise ValueError("商品マスタの対応形式は .xlsx / .xlsm / .csv です")
