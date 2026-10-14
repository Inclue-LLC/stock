// 在庫の中心となる処理（画面や保存先に依存しない）。
//
// 状態（state）の形:
//   products:  Map<id, {id, name, jan, sku, brand, character, price, unit, note}>
//   locations: Map<id, {id, name, region, type, note, updated_at}>
//   stocks:    Map<拠点id, Map<商品id, {q: 在庫, del: 納品累計, sold: 販売累計, adj: 調整累計, dels: {日付: 納品数}}>>
//
// 変更は working(state) で作った作業用コピーに対して行い、保存側が dirty な部分だけを書き込む。

import { tryNormalize } from "./jan.js";

export const REGIONS = { JP: "日本", CN: "中国" };
export const TYPES = { WAREHOUSE: "倉庫", CONSIGNMENT: "委託店舗" };
export const KINDS = { IN: "納品", OUT: "販売", SET: "在庫更新", TRANSFER_OUT: "移動出", TRANSFER_IN: "移動入" };
export const IMPORT_KIND_LABELS = { SET: "在庫数を上書き", IN: "納品・入庫（加算）", OUT: "販売・出庫（減算）" };
export const SOURCES = { MANUAL: "手入力", EXCEL: "Excel", CSV: "CSV", PDF: "PDF" };
export const LOW_STOCK = 10; // この数以下を「残りわずか」として目立たせる
export const CATEGORIES = Object.keys(REGIONS).flatMap((r) => Object.keys(TYPES).map((t) => [r, t]));

export class StockError extends Error {}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

/** 日本時間の今日（YYYY-MM-DD）。 */
export function todayJst(now = new Date()) {
  return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

export function emptyState() {
  return { products: new Map(), locations: new Map(), stocks: new Map() };
}

/** 変更用の作業コピーを作る。dirty 情報と、この操作で発生した履歴（movements）を持つ。 */
export function working(state) {
  const stocks = new Map();
  for (const [lid, items] of state.stocks) {
    stocks.set(lid, new Map([...items].map(([pid, s]) => [pid, { ...s, dels: { ...s.dels } }])));
  }
  return {
    products: new Map([...state.products].map(([id, p]) => [id, { ...p }])),
    locations: new Map([...state.locations].map(([id, l]) => [id, { ...l }])),
    stocks,
    catalogDirty: false,
    dirtyStocks: new Set(),
    movements: [],
  };
}

// ---- 並び順・検索 ----------------------------------------------------------------

const RORDER = Object.keys(REGIONS);
const TORDER = Object.keys(TYPES);
const ja = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function sortedLocations(state) {
  return [...state.locations.values()].sort((a, b) =>
    RORDER.indexOf(a.region) - RORDER.indexOf(b.region) || TORDER.indexOf(a.type) - TORDER.indexOf(b.type)
    || ja(a.name, b.name));
}

/** 商品の並び順: キャラクター名 → JANコード → 商品名（キャラクター名・JAN が空のものは後ろ）。 */
export function compareProducts(a, b) {
  return ja(a.character || "\uffff", b.character || "\uffff") || ja(a.jan || "\uffff", b.jan || "\uffff")
    || ja(a.name, b.name);
}

export function sortedProducts(state) {
  return [...state.products.values()].sort(compareProducts);
}

/** JAN（前方一致）・品番・商品名（部分一致）で絞り込む。 */
export function matches(product, q) {
  q = (q || "").trim();
  if (!q) return true;
  const ql = q.toLowerCase();
  return (product.jan || "").startsWith(q) || (product.sku || "").toLowerCase().includes(ql)
    || product.name.toLowerCase().includes(ql) || (product.character || "").toLowerCase().includes(ql);
}

export function stockEntry(state, lid, pid) {
  return state.stocks.get(lid)?.get(pid) || null;
}

export function currentQty(state, lid, pid) {
  return stockEntry(state, lid, pid)?.q || 0;
}

export function allStocks(state) {
  const out = [];
  for (const [lid, items] of state.stocks) {
    const location = state.locations.get(lid);
    if (!location) continue;
    for (const [pid, s] of items) {
      const product = state.products.get(pid);
      if (product) out.push({ product, location, ...s });
    }
  }
  return out;
}

export function stockRows(state, { region, type, locationId, q, includeZero } = {}) {
  const rows = allStocks(state).filter((s) =>
    (!region || s.location.region === region) && (!type || s.location.type === type)
    && (!locationId || s.location.id === locationId) && matches(s.product, q) && (includeZero || s.q !== 0));
  return rows.sort((a, b) => compareProducts(a.product, b.product)
    || RORDER.indexOf(a.location.region) - RORDER.indexOf(b.location.region)
    || TORDER.indexOf(a.location.type) - TORDER.indexOf(b.location.type) || ja(a.location.name, b.location.name));
}

/** 登録されているキャラクター名（五十音順）。 */
export function characterList(state) {
  return [...new Set([...state.products.values()].map((p) => p.character || "").filter(Boolean))].sort(ja);
}

/**
 * 商品ごとに [商品, 地域×種別の4区分..., 合計] を返す。
 * characters: 絞り込むキャラクター名の配列（"" はキャラクター名なし）。空なら全件。
 */
export function productTotals(state, q = "", onlyInStock = false, characters = []) {
  const chars = new Set(characters);
  const sums = new Map();
  for (const s of allStocks(state)) {
    const key = `${s.location.region}/${s.location.type}`;
    const m = sums.get(s.product.id) || {};
    m[key] = (m[key] || 0) + s.q;
    sums.set(s.product.id, m);
  }
  const rows = [];
  for (const p of sortedProducts(state)) {
    if (!matches(p, q) || (chars.size && !chars.has(p.character || ""))) continue;
    const cats = CATEGORIES.map(([r, t]) => sums.get(p.id)?.[`${r}/${t}`] || 0);
    const total = cats.reduce((a, b) => a + b, 0);
    if (onlyInStock && total === 0) continue;
    rows.push([p, ...cats, total]);
  }
  return rows;
}

/**
 * 商品ごとに、拠点ごとの在庫数を返す。{ locations: 拠点（地域 → 種別 → 名前順）, rows: [[商品, 拠点ごとの数..., 合計]] }
 * characters: 絞り込むキャラクター名（"" はキャラクター名なし）。空なら全件。
 */
export function productLocationTotals(state, { q = "", onlyInStock = false, characters = [] } = {}) {
  const chars = new Set(characters);
  const locations = sortedLocations(state);
  const rows = [];
  for (const p of sortedProducts(state)) {
    if (!matches(p, q) || (chars.size && !chars.has(p.character || ""))) continue;
    const qtys = locations.map((l) => state.stocks.get(l.id)?.get(p.id)?.q || 0);
    const total = qtys.reduce((a, b) => a + b, 0);
    if (onlyInStock && total === 0) continue;
    rows.push([p, ...qtys, total]);
  }
  return { locations, rows };
}

export function productTotal(state, pid) {
  let total = 0;
  for (const items of state.stocks.values()) total += items.get(pid)?.q || 0;
  return total;
}

export function locationTotal(state, lid) {
  let total = 0;
  for (const s of state.stocks.get(lid)?.values() || []) total += s.q;
  return total;
}

/** その商品・拠点に在庫や履歴の記録があるか（削除可否の判定に使う）。 */
export function productHasRecords(state, pid) {
  for (const items of state.stocks.values()) if (items.has(pid)) return true;
  return false;
}

export function locationHasRecords(state, lid) {
  return (state.stocks.get(lid)?.size || 0) > 0;
}

export function paginate(items, page, perPage = 50) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  page = Math.max(1, Math.min(page || 1, pages));
  const from = page === 1 ? 0 : (page - 1) * perPage; // perPage = Infinity（全件表示）でも NaN にしない
  return {
    items: items.slice(from, from + perPage), page, pages, total,
    start: total ? from + 1 : 0, end: Math.min(total, from + perPage),
  };
}

// ---- 在庫の増減 -------------------------------------------------------------------

export function computeDelta(kind, current, quantity) {
  if (quantity < 0) throw new StockError("数量は0以上で入力してください");
  if (kind === "IN" || kind === "TRANSFER_IN") return quantity;
  if (kind === "OUT" || kind === "TRANSFER_OUT") return -quantity;
  if (kind === "SET") return quantity - current;
  throw new StockError(`不明な区分: ${kind}`);
}

/** 在庫を増減し、履歴と店舗別明細用の累計（納品・販売・調整）を更新する。W は working() の作業コピー。 */
export function applyMovement(W, { productId, locationId, kind, quantity, date = null, note = "", now = Date.now() }) {
  const product = W.products.get(productId);
  const location = W.locations.get(locationId);
  const current = currentQty(W, locationId, productId);
  const delta = computeDelta(kind, current, quantity);
  const after = current + delta;
  if (after < 0) {
    throw new StockError(`${product.name}（${location.name}）の在庫が不足しています: 現在 ${current}、出庫 ${quantity}`);
  }
  if (!W.stocks.has(locationId)) W.stocks.set(locationId, new Map());
  const items = W.stocks.get(locationId);
  const s = items.get(productId) || { q: 0, del: 0, sold: 0, adj: 0, dels: {} };
  s.q = after;
  if (kind === "IN" || kind === "TRANSFER_IN") {
    const d = date || todayJst(new Date(now));
    s.dels[d] = (s.dels[d] || 0) + delta;
    s.del += delta;
  } else if (kind === "OUT" || kind === "TRANSFER_OUT") {
    s.sold += -delta;
  } else {
    s.adj += delta;
  }
  items.set(productId, s);
  W.dirtyStocks.add(locationId);
  location.updated_at = now;
  W.catalogDirty = true;
  const m = { p: productId, l: locationId, k: kind, d: delta, a: after, dt: date, n: note };
  W.movements.push(m);
  return m;
}

// ---- 商品の特定 -------------------------------------------------------------------

export function productByJan(state, jan) {
  for (const p of state.products.values()) if (p.jan === jan) return p;
  return null;
}

export function productsByName(state, name, janNoneOnly = false) {
  name = name.trim();
  return [...state.products.values()].filter((p) => p.name === name && (!janNoneOnly || !p.jan));
}

export function locationByName(state, name) {
  name = name.trim();
  for (const l of state.locations.values()) if (l.name === name) return l;
  return null;
}

/** JAN のない商品を商品名で探す。[商品, エラー] */
export function findProductByName(state, name) {
  const found = productsByName(state, name);
  if (found.length > 1) return [null, `商品名「${name}」の商品が複数あります。JANコードで指定してください`];
  return [found[0] || null, null];
}

/**
 * JAN → 品番 → 商品名（JANなし商品）の順に商品を探す。[商品, 正規化済みJAN, エラー]
 * JAN が正しい形式で未登録なら [null, jan, null]、JAN・品番がなく商品名が未登録なら [null, null, null]（どちらも新規登録可能）。
 */
export function findProduct(state, jan = "", sku = "", name = "") {
  if (jan) {
    const [code, err] = tryNormalize(jan);
    if (err) return [null, null, err];
    return [productByJan(state, code), code, null];
  }
  if (sku) {
    const found = [...state.products.values()].filter((p) => p.sku === sku);
    if (found.length === 1) return [found[0], found[0].jan, null];
    if (found.length > 1) return [null, null, `品番「${sku}」の商品が複数あります。JANコードで指定してください`];
    if (!name) return [null, null, `品番「${sku}」の商品は未登録です`];
  }
  if (name) {
    const [product, err] = findProductByName(state, name);
    return [product, product ? product.jan : null, err];
  }
  return [null, null, "JANコード・品番・商品名のいずれも読み取れません"];
}

// ---- 商品・拠点の登録 ----------------------------------------------------------------

export function saveProduct(W, product) {
  if (product.jan) {
    const dup = productByJan(W, product.jan);
    if (dup && dup.id !== product.id) throw new StockError(`JANコード「${product.jan}」はすでに登録されています`);
  }
  const p = { name: "", jan: null, sku: "", brand: "", character: "", price: null, unit: "個", note: "", ...product };
  p.id = p.id || newId();
  W.products.set(p.id, p);
  W.catalogDirty = true;
  return p;
}

export function saveLocation(W, location) {
  const dup = locationByName(W, location.name);
  if (dup && dup.id !== location.id) throw new StockError(`拠点「${location.name}」はすでに登録されています`);
  const l = { note: "", updated_at: null, ...location };
  l.id = l.id || newId();
  W.locations.set(l.id, l);
  W.catalogDirty = true;
  return l;
}

/** 記録のない商品を削除する。 */
/** 商品を削除する。各拠点のこの商品の在庫も削除する（入出庫履歴の記録自体は残るが、画面には表示されない）。 */
export function deleteProduct(W, pid) {
  if (!W.products.has(pid)) throw new StockError("商品が見つかりません");
  for (const [lid, items] of W.stocks) {
    if (items.delete(pid)) W.dirtyStocks.add(lid);
  }
  W.products.delete(pid);
  W.catalogDirty = true;
}

/** 記録のない拠点を削除する。 */
export function deleteLocation(W, lid) {
  if (locationHasRecords(W, lid)) throw new StockError("入出庫履歴がある拠点は削除できません");
  W.locations.delete(lid);
  W.stocks.delete(lid);
  W.deletedStocks = new Set([...(W.deletedStocks || []), lid]);
  W.catalogDirty = true;
}

/** 商品マスタを JAN（なければ商品名）をキーに新規登録 / 更新する（空欄の項目は上書きしない）。 */
export function importProducts(W, rows) {
  const result = { created: 0, updated: 0, errors: [] };
  const seen = new Map();
  rows.forEach((row, i) => {
    let key;
    let product;
    let code = null;
    if (row.jan) {
      const [c, err] = tryNormalize(row.jan);
      if (err) {
        result.errors.push(`${i + 1}件目: ${err}`);
        return;
      }
      code = c;
      key = code;
      product = seen.get(key) || productByJan(W, code);
    } else {
      if (!row.name) return;
      key = `name:${row.name}`;
      if (seen.has(key)) product = seen.get(key);
      else {
        const [p, err] = findProductByName(W, row.name);
        if (err) {
          result.errors.push(`${i + 1}件目: ${err}`);
          return;
        }
        product = p;
      }
    }
    if (!product) {
      if (!row.name) {
        result.errors.push(`${i + 1}件目: JAN ${code} の商品名がありません`);
        return;
      }
      product = { jan: code, name: row.name };
      result.created++;
    } else if (!seen.has(key)) {
      result.updated++;
    }
    for (const f of ["name", "sku", "unit", "note", "brand", "character"]) if (row[f]) product[f] = row[f];
    if (row.price !== null && row.price !== undefined) product.price = row.price;
    seen.set(key, saveProduct(W, product));
  });
  return result;
}

// ---- 手入力 ----------------------------------------------------------------------

/**
 * 画面で入力した在庫数で上書きする。changes: [{ productId, locationId, quantity }]
 * 変わらないものは記録しない。戻り値: 変更した件数
 */
export function setQuantities(W, changes, { date = null, now = Date.now() } = {}) {
  let changed = 0;
  for (const { productId, locationId, quantity } of changes) {
    const product = W.products.get(productId);
    const location = W.locations.get(locationId);
    if (!product || !location) throw new StockError("商品または拠点が見つかりません（他の人が削除した可能性があります）");
    const q = Number(quantity);
    if (!Number.isInteger(q) || q < 0) throw new StockError(`${product.name}（${location.name}）の在庫数は 0 以上の整数で入力してください`);
    if (currentQty(W, locationId, productId) === q) continue;
    applyMovement(W, { productId, locationId, kind: "SET", quantity: q, date: date || todayJst(new Date(now)), note: "手入力", now });
    changed++;
  }
  return changed;
}

// ---- 在庫取込 --------------------------------------------------------------------

/** 商品名の比較用（全角・半角、空白の違いは同じとみなす）。 */
export const nameKey = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim();

/**
 * 各行に商品・拠点の解決結果とエラーを付けたプレビュー用リストを返す。
 * name_diff: 登録済みの商品と、ファイルの商品名が違う（JAN・品番で照合した行）
 */
export function validateBatch(state, batch) {
  const pending = new Map(); // 同一ファイル内の累積（出庫時の在庫チェック用）
  const defaultLoc = batch.location_id ? state.locations.get(batch.location_id) || null : null;
  return batch.rows.map((row, index) => {
    const item = { ...row, index, errors: [], product: null, location: null, current: null, after: null,
      location_name: row.location, jan_code: null };
    const [product, code, err] = findProduct(state, row.jan || "", row.sku || "", row.name || "");
    item.product = product;
    item.jan_code = code;
    item.name_diff = !!(product && row.name && nameKey(row.name) !== nameKey(product.name));
    // 同一ファイル内で同じ商品を指す行をまとめるためのキー
    item.key = product ? `id:${product.id}` : code || `name:${row.name || ""}`;
    if (err) item.errors.push(err);
    else if (!product && !row.name) item.errors.push("未登録のJANで、商品名がありません");
    const loc = row.location ? locationByName(state, row.location) : defaultLoc;
    item.location = loc;
    if (!loc) item.errors.push(row.location ? `拠点「${row.location}」が見つかりません` : "拠点が未指定です");
    if (row.quantity === null || row.quantity === undefined) item.errors.push("数量が読み取れません");
    if (loc && !err && row.quantity !== null && row.quantity !== undefined) {
      const key = `${item.key}|${loc.id}`;
      const current = pending.has(key) ? pending.get(key) : product ? currentQty(state, loc.id, product.id) : 0;
      try {
        const after = current + computeDelta(batch.kind, current, row.quantity);
        if (after < 0) item.errors.push(`在庫不足（現在 ${current}）`);
        item.current = current;
        item.after = after;
        if (!item.errors.length) pending.set(key, after);
      } catch (e) {
        if (!(e instanceof StockError)) throw e;
        item.errors.push(e.message);
      }
    }
    return item;
  });
}

/** 在庫更新で「ファイルにない商品を0にする」とき、0にされる在庫。対象はファイル内で正常に読めた行の拠点のみ。 */
export function missingStocks(state, batch, preview) {
  if (!(batch.zero_missing && batch.kind === "SET")) return [];
  const inFile = new Map();
  for (const item of preview) {
    if (item.errors.length) continue;
    if (!inFile.has(item.location.id)) inFile.set(item.location.id, new Set());
    if (item.product) inFile.get(item.location.id).add(item.product.id);
  }
  return allStocks(state)
    .filter((s) => inFile.has(s.location.id) && s.q !== 0 && !inFile.get(s.location.id).has(s.product.id))
    .sort((a, b) => ja(a.location.name, b.location.name) || ja(a.product.name, b.product.name));
}

/**
 * 取込を反映する。W は working() の作業コピー。戻り値 { applied, skipped, zeroed, renamed }
 * renames: 商品名をファイルの名前に変える行の番号（index）。それ以外は登録済みの商品名のまま。
 */
export function applyBatch(W, batch, now = Date.now(), { renames = [] } = {}) {
  const rename = new Set(renames.map(Number));
  let renamed = 0;
  if (batch.status !== "pending") throw new StockError("この取込はすでに処理済みです");
  let applied = 0;
  let skipped = 0;
  const created = new Map();
  const preview = validateBatch(W, batch);
  const missing = missingStocks(W, batch, preview);
  for (const item of preview) {
    if (item.errors.length) {
      skipped++;
      continue;
    }
    let product = item.product ? W.products.get(item.product.id) : created.get(item.key);
    if (!product) {
      product = saveProduct(W, { jan: item.jan_code, sku: item.sku || "", name: item.name, unit: item.unit || "個",
        brand: item.brand || "", character: item.character || "", price: item.price ?? null });
      created.set(item.key, product);
    } else if ((!product.brand && item.brand) || (!product.character && item.character)
      || (product.price == null && item.price != null)) {
      // マスタの空欄（ブランド・キャラクター・上代）はファイルの値で補う
      product.brand = product.brand || item.brand || "";
      product.character = product.character || item.character || "";
      if (product.price == null) product.price = item.price;
      saveProduct(W, product);
    }
    if (item.name_diff && rename.has(item.index) && nameKey(product.name) !== nameKey(item.name)) {
      product.name = item.name;
      saveProduct(W, product);
      renamed++;
    }
    applyMovement(W, { productId: product.id, locationId: item.location.id, kind: batch.kind, quantity: item.quantity,
      date: batch.date, note: item.note || batch.filename, now });
    applied++;
  }
  for (const s of missing) {
    applyMovement(W, { productId: s.product.id, locationId: s.location.id, kind: "SET", quantity: 0, date: batch.date,
      note: `${batch.filename} に記載なし`, now });
  }
  return { applied, skipped, zeroed: missing.length, renamed };
}

/** 拠点の在庫一覧（キャラクター名 → JANコード順）。[{ product, q }] */
export function locationStockRows(state, locationId, { q = "", includeZero = false } = {}) {
  const rows = [];
  for (const [pid, s] of state.stocks.get(locationId) || []) {
    const product = state.products.get(pid);
    if (product && matches(product, q) && (includeZero || s.q !== 0)) rows.push({ product, q: s.q });
  }
  return rows.sort((a, b) => compareProducts(a.product, b.product));
}

// ---- 拠点（店舗）別レポート ------------------------------------------------------------

export function sellThrough(sold, stock) {
  const base = sold + Math.max(stock, 0);
  return base ? sold / base : null; // 消化率 = 販売数 ÷（販売数 ＋ 在庫数）
}

/** 拠点ごとに、商品別の 納品（日付別）・販売・在庫更新差分・現在庫 を集計する。 */
export function storeReport(state, locationId, { brand = "", q = "" } = {}) {
  const all = [];
  for (const [pid, s] of state.stocks.get(locationId) || []) {
    const product = state.products.get(pid);
    if (!product) continue;
    const price = product.price ?? null;
    all.push({
      product, deliveries: s.dels, delivered: s.del, sold: s.sold, adjusted: s.adj, stock: s.q,
      sell_through: sellThrough(s.sold, s.q),
      sales_amount: price === null ? null : s.sold * price,
      stock_amount: price === null ? null : s.q * price,
    });
  }
  const brands = [...new Set(all.map((r) => r.product.brand).filter(Boolean))].sort(ja);
  const dates = [...new Set(all.flatMap((r) => Object.keys(r.deliveries).filter((d) => r.deliveries[d])))].sort();
  const rows = all.filter((r) => (!brand || r.product.brand === brand) && matches(r.product, q));
  rows.sort((a, b) => ja(a.product.brand || "\uffff", b.product.brand || "\uffff") || compareProducts(a.product, b.product));
  const total = (k) => rows.reduce((acc, r) => acc + (r[k] || 0), 0);
  return {
    rows, delivery_dates: dates, brands, total,
    deliveryTotal: (d) => rows.reduce((acc, r) => acc + (r.deliveries[d] || 0), 0),
    sell_through: sellThrough(total("sold"), rows.reduce((acc, r) => acc + Math.max(r.stock, 0), 0)),
  };
}
