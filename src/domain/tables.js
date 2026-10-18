// 2次元の表（Excel / CSV / PDF から得たもの）から、見出し行を探して明細行（JAN・品番・商品名・数量・拠点）を取り出す。
// 見出しは日本語・中国語・英語に対応し、先頭付近から自動で探す。

export const HEADER_ALIASES = {
  jan: ["jan", "janコード", "jancode", "jan code", "バーコード", "ean", "ean13", "ean code", "barcode",
    "条码", "条形码", "商品条码", "国际条码"],
  sku: ["sku", "品番", "商品コード", "商品番号", "型番", "品目コード", "コード",
    "item code", "itemcode", "code", "货号", "商品编码", "编码", "编号", "产品编号"],
  name: ["商品名", "品名", "品目", "品目名", "名称", "製品名", "item", "name", "product", "description",
    "商品名称", "产品名称", "品名称"],
  quantity: ["数量", "個数", "在庫数", "在庫", "入庫数", "出庫数", "販売数", "売上数", "販売点数", "納品数",
    "納品数量", "入荷数", "出荷数", "残数", "残数量", "月末在庫", "期末在庫", "実在庫", "実在庫数",
    "qty", "quantity", "count", "数", "库存", "库存数量", "入库数量", "出库数量", "销售数量", "销量"],
  location: ["拠点", "納品先", "倉庫", "店舗", "保管場所", "委託先", "location", "warehouse", "store", "仓库", "门店", "店铺"],
  unit: ["単位", "unit", "单位"],
  brand: ["ブランド", "brand", "メーカー", "品牌"],
  character: ["キャラクター", "キャラクター名", "キャラ", "キャラ名", "character", "角色", "角色名", "人物"],
  price: ["上代", "上代（税込）", "上代(税込)", "上代税込", "売価", "売価（税込）", "定価", "販売価格", "価格",
    "price", "retail price", "零售价", "售价"],
  note: ["備考", "メモ", "note", "remarks", "备注"],
};

// どの列があれば取込対象の表とみなすか（配列内はいずれか1つ）
export const STOCK_REQUIRED = [["jan", "sku", "name"], ["quantity"]];
export const PRODUCT_REQUIRED = [["jan"], ["name"]];
const HEADER_SCAN_ROWS = 30;
const TOTAL_WORDS = new Set(["合計", "小計", "total", "合计", "小计"]);

export function norm(text) {
  if (text === null || text === undefined) return "";
  return String(text).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

const ALIAS_LOOKUP = new Map();
for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const a of aliases) ALIAS_LOOKUP.set(norm(a), key);
}

export function parseQuantity(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  const s = norm(value).replace(/,/g, "");
  const m = s.match(/^(-?\d+(?:\.0+)?)[^\d]*$/);
  return m ? Math.trunc(Number(m[1])) : null;
}

/** 金額（「¥1,650」「1650円」なども読む）。 */
export function parsePrice(value) {
  if (typeof value === "string") value = value.normalize("NFKC").replace(/^\s*[¥\\$]\s*/, "");
  return parseQuantity(value);
}

export function matchHeader(cells, required = STOCK_REQUIRED) {
  const mapping = {};
  cells.forEach((cell, idx) => {
    const key = ALIAS_LOOKUP.get(norm(cell));
    if (key && !(key in mapping)) mapping[key] = idx;
  });
  return required.every((group) => group.some((k) => k in mapping)) ? mapping : null;
}

/** Excel の数値セル（4901234567894 など）も含めてコードを文字列にする。 */
export function codeStr(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isInteger(value)) value = BigInt(value).toString();
  return String(value).normalize("NFKC").trim();
}

export function newResult() {
  return { rows: [], warnings: [] };
}

/** 2次元配列からヘッダーを検出して明細行を result に追加する。ヘッダーが見つかれば true。 */
export function rowsFromTable(table, result, label = "", required = STOCK_REQUIRED) {
  let headerIdx = -1;
  let mapping = null;
  for (let i = 0; i < Math.min(table.length, HEADER_SCAN_ROWS); i++) {
    mapping = matchHeader(table[i] || [], required);
    if (mapping) {
      headerIdx = i;
      break;
    }
  }
  if (!mapping) return false;

  const cell = (cells, key) => {
    const idx = mapping[key];
    if (idx === undefined || idx >= cells.length) return null;
    const v = cells[idx];
    return typeof v === "string" ? v.trim() : v;
  };
  const text = (v) => (v === null || v === undefined || v === "" ? "" : String(v));

  for (let r = headerIdx + 1; r < table.length; r++) {
    const cells = table[r] || [];
    const jan = codeStr(cell(cells, "jan"));
    const sku = codeStr(cell(cells, "sku"));
    const name = cell(cells, "name");
    const rawQty = cell(cells, "quantity");
    const qty = parseQuantity(rawQty);
    if (TOTAL_WORDS.has(norm(jan || sku || name))) continue;
    if (!jan && !sku) {
      // JAN・品番のない行は、商品名があり（在庫ファイルなら数量も）ある場合だけ JAN なし商品として扱う
      if (name === null || name === "" || ("quantity" in mapping && qty === null)) continue;
    }
    if ("quantity" in mapping && qty === null) {
      result.warnings.push(`${label}${r + 1}行目: 数量「${text(rawQty)}」を読み取れません`);
    }
    const location = cell(cells, "location");
    result.rows.push({
      jan,
      sku,
      name: text(name),
      quantity: qty,
      location: location === null || location === "" ? null : String(location),
      unit: text(cell(cells, "unit")),
      brand: text(cell(cells, "brand")),
      character: text(cell(cells, "character")),
      price: parsePrice(cell(cells, "price")),
      note: text(cell(cells, "note")),
    });
  }
  return true;
}

export function headerMissing(required) {
  return required === PRODUCT_REQUIRED
    ? "見出し行（JANコード・商品名）が見つかりませんでした"
    : "見出し行（JANコード または 品番、数量）が見つかりませんでした";
}

/** 複数のシート（[シート名, 2次元配列]）から読み取る。 */
export function parseSheets(sheets, required = STOCK_REQUIRED) {
  const result = newResult();
  let found = false;
  for (const [title, table] of sheets) {
    const label = sheets.length > 1 ? `[${title}] ` : "";
    if (rowsFromTable(table, result, label, required)) found = true;
  }
  if (!found) result.warnings.push(headerMissing(required));
  return result;
}

// 表として抽出できない PDF 用: 「JAN(または品番) 商品名 数量」の並びの行を拾う
const LINE_RE = /^([A-Za-z0-9][\w\-./]*)\s+(.+?)\s+(-?\d[\d,]*)\s*\S{0,3}$/;

/** PDF のテキスト行から明細を推定する（表が見つからないときの代替）。 */
export function rowsFromLines(lines) {
  const rows = [];
  for (const line of lines) {
    const m = String(line).normalize("NFKC").trim().match(LINE_RE);
    if (!m) continue;
    const isJan = /^(\d{8}|\d{13})$/.test(m[1]);
    rows.push({
      jan: isJan ? m[1] : "", sku: isJan ? "" : m[1], name: m[2].trim(), quantity: parseQuantity(m[3]),
      location: null, unit: "", brand: "", character: "", price: null, note: "",
    });
  }
  return rows;
}
