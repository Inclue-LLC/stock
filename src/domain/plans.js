// 納品予定（タスク管理）。
//
// plan: { id, title: 納品先の拠点名, location_id: 納品先, source_id: 出荷元（任意）,
//         status: todo（予定）/done（完了）, memo, lines: [{ product_id, jan, name, quantity }],
//         done_date, applied: 在庫に反映したか, created_at, updated_at }

import { tryNormalize } from "./jan.js";
import { StockError, applyMovement, locationByName, nameKey, productByJan, productsByName, saveProduct } from "./inventory.js";

export const PLAN_STATUS = { todo: "予定", done: "完了" };
export const OPEN_STATUSES = ["todo"];

/** 状態は「予定」「完了」の2つ（以前の「準備中」「取消」は「予定」として扱う）。 */
export const planStatus = (status) => (status === "done" ? "done" : "todo");

/** 納品予定の名前 = 納品先の拠点名（拠点が削除されていれば保存時の名前）。 */
export const planTitle = (state, plan) => state.locations.get(plan.location_id)?.name || plan.title || "納品先未設定";

export function emptyPlan() {
  return { id: null, title: "", location_id: "", source_id: "", due: "", status: "todo", memo: "", lines: [],
    done_date: null, applied: false };
}

export const planQuantity = (plan) => plan.lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);

export function sortPlans(plans) {
  // 登録の古い順（同じなら拠点名順）
  const t = (p) => p.created_at?.getTime?.() ?? Infinity;
  return [...plans].sort((a, b) => t(a) - t(b) || (a.title || "").localeCompare(b.title || "", "ja"));
}

/** 拠点宛ての、まだ完了していない納品予定。 */
export function openPlansFor(state, locationId) {
  return sortPlans([...(state.plans?.values() || [])].filter((p) => p.location_id === locationId && OPEN_STATUSES.includes(p.status)));
}

/** 明細の商品を特定する。[商品 or null, 新規登録用の JAN, エラー] */
export function resolveLine(state, line) {
  if (line.product_id && state.products.get(line.product_id)) return [state.products.get(line.product_id), null, null];
  if (line.jan) {
    const [code, err] = tryNormalize(line.jan);
    if (err) return [null, null, err];
    const p = productByJan(state, code);
    if (p) return [p, code, null];
    return line.name ? [null, code, null] : [null, null, `JAN ${code} の商品は未登録です（商品名を入れると新規登録します）`];
  }
  if (line.name) {
    const found = productsByName(state, line.name);
    if (found.length === 1) return [found[0], null, null];
    if (found.length > 1) return [null, null, `商品名「${line.name}」の商品が複数あります。JANコードで指定してください`];
    return [null, null, `商品「${line.name}」が見つかりません（JANコードを入れると新規登録します）`];
  }
  return [null, null, "商品が指定されていません"];
}

/** 入力欄の文字（「JAN 商品名」または商品名）から明細を作る。 */
export function lineFromText(state, text, quantity) {
  const t = String(text || "").normalize("NFKC").trim();
  const m = t.match(/^(\d{8}|\d{13})(?:\s+(.*))?$/);
  const line = m ? { jan: m[1], name: (m[2] || "").trim(), quantity } : { jan: "", name: t, quantity };
  const [product] = resolveLine(state, line);
  return product ? { product_id: product.id, jan: product.jan || "", name: product.name, quantity } : { product_id: null, ...line };
}

/**
 * 納品予定を完了し、在庫に反映する。W は working() の作業コピー。
 * 納品先に「納品」として加算し、出荷元があれば出荷元から「移動出」として減算する。
 */
export function applyPlan(W, plan, date) {
  if (!W.locations.get(plan.location_id)) throw new StockError("納品先の拠点が見つかりません");
  if (plan.source_id && !W.locations.get(plan.source_id)) throw new StockError("出荷元の拠点が見つかりません");
  const note = `納品予定「${plan.title}」`;
  let quantity = 0;
  plan.lines.forEach((line, i) => {
    const q = Number(line.quantity) || 0;
    if (q <= 0) return;
    let [product, code, err] = resolveLine(W, line);
    if (err) throw new StockError(`明細${i + 1}行目: ${err}`);
    const price = line.price ?? null;
    if (!product) product = saveProduct(W, { jan: code, name: line.name, character: line.character || "", price });
    else if ((!product.character && line.character) || (price != null && product.price !== price)) {
      product = saveProduct(W, { ...product, character: product.character || line.character || "", price: price ?? product.price });
    }
    if (plan.source_id) {
      applyMovement(W, { productId: product.id, locationId: plan.source_id, kind: "TRANSFER_OUT", quantity: q, date, note });
    }
    applyMovement(W, { productId: product.id, locationId: plan.location_id, kind: "IN", quantity: q, date, note });
    quantity += q;
  });
  return { quantity };
}

/**
 * 取込ファイルの行から納品予定を作る。拠点ごとに1件。
 * タイトルは納品先の拠点名。options: { source_id, location_id: 「拠点」列が空の行に使う納品先 }
 * 戻り値: { plans, errors: ["N行目: ..."], lines: 取り込んだ行数,
 *          diffs: 登録済みと商品名が違う商品 [{ product, names: [ファイルの商品名...] }] }
 */
export function plansFromRows(state, rows, { source_id = "", location_id = "" } = {}) {
  const groups = new Map();
  const errors = [];
  let lines = 0;
  const diffs = new Map();
  rows.forEach((row, i) => {
    const no = `${i + 1}件目`;
    const loc = row.location ? locationByName(state, row.location) : state.locations.get(location_id) || null;
    if (!loc) {
      errors.push(`${no}: ${row.location ? `拠点「${row.location}」が見つかりません` : "拠点が未指定です"}`);
      return;
    }
    if (source_id && loc.id === source_id) {
      errors.push(`${no}: 納品先が出荷元と同じです`);
      return;
    }
    if (row.quantity === null || row.quantity === undefined || row.quantity <= 0) {
      errors.push(`${no}: 数量が読み取れません`);
      return;
    }
    const [product, code, err] = resolveLine(state, { jan: row.jan, name: row.name });
    if (err) {
      errors.push(`${no}: ${err}`);
      return;
    }
    if (product && row.name && nameKey(row.name) !== nameKey(product.name)) {
      if (!diffs.has(product.id)) diffs.set(product.id, { product, names: [] });
      const d = diffs.get(product.id);
      if (!d.names.some((x) => nameKey(x) === nameKey(row.name))) d.names.push(row.name);
    }
    if (!groups.has(loc.id)) groups.set(loc.id, []);
    groups.get(loc.id).push(product
      ? { product_id: product.id, jan: product.jan || "", name: product.name, character: row.character || product.character || "",
        price: row.price ?? null, quantity: row.quantity }
      : { product_id: null, jan: code || "", name: row.name, character: row.character || "", price: row.price ?? null, quantity: row.quantity });
    lines++;
  });
  const plans = [...groups].map(([lid, items]) => ({
    ...emptyPlan(), title: state.locations.get(lid).name, location_id: lid, source_id, lines: items,
  }));
  return { plans, errors, lines, diffs: [...diffs.values()] };
}

/** 商品名の変更（[{ productId, name }]）を、納品予定の明細の商品名にも反映する。 */
export function renameLines(plans, renames) {
  const names = new Map(renames.map((r) => [r.productId, r.name]));
  return plans.map((p) => ({ ...p, lines: p.lines.map((l) => (names.has(l.product_id) ? { ...l, name: names.get(l.product_id) } : l)) }));
}
