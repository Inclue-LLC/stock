// 納品予定（タスク管理）。
//
// plan: { id, title, location_id: 納品先, source_id: 出荷元（任意）, due: 予定日 YYYY-MM-DD,
//         status: todo/doing/done/cancelled, memo, lines: [{ product_id, jan, name, quantity }],
//         done_date, applied: 在庫に反映したか, created_at, updated_at }

import { tryNormalize } from "./jan.js";
import { StockError, applyMovement, productByJan, productsByName, saveProduct, todayJst } from "./inventory.js";

export const PLAN_STATUS = { todo: "予定", doing: "準備中", done: "完了", cancelled: "取消" };
export const OPEN_STATUSES = ["todo", "doing"];

export function emptyPlan(today = todayJst()) {
  return { id: null, title: "", location_id: "", source_id: "", due: today, status: "todo", memo: "", lines: [],
    done_date: null, applied: false };
}

/** 予定日までの日数（過ぎていればマイナス）。 */
export function daysUntil(due, today = todayJst()) {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** 予定日の状態: overdue（過ぎている）/ today / soon（7日以内）/ ""。完了・取消は "" */
export function dueClass(plan, today = todayJst()) {
  if (!OPEN_STATUSES.includes(plan.status) || !plan.due) return "";
  const d = daysUntil(plan.due, today);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  return d <= 7 ? "soon" : "";
}

export function dueLabel(plan, today = todayJst()) {
  if (!plan.due) return "";
  const d = daysUntil(plan.due, today);
  const date = plan.due.slice(5).replace("-", "/");
  if (!OPEN_STATUSES.includes(plan.status)) return date;
  if (d < 0) return `${date}（${-d}日過ぎ）`;
  if (d === 0) return `${date}（今日）`;
  return `${date}（あと${d}日）`;
}

export const planQuantity = (plan) => plan.lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);

export function sortPlans(plans) {
  return [...plans].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || (a.title || "").localeCompare(b.title || ""));
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
  const note = `納品予定「${plan.title || plan.due}」`;
  let quantity = 0;
  plan.lines.forEach((line, i) => {
    const q = Number(line.quantity) || 0;
    if (q <= 0) return;
    let [product, code, err] = resolveLine(W, line);
    if (err) throw new StockError(`明細${i + 1}行目: ${err}`);
    if (!product) product = saveProduct(W, { jan: code, name: line.name });
    if (plan.source_id) {
      applyMovement(W, { productId: product.id, locationId: plan.source_id, kind: "TRANSFER_OUT", quantity: q, date, note });
    }
    applyMovement(W, { productId: product.id, locationId: plan.location_id, kind: "IN", quantity: q, date, note });
    quantity += q;
  });
  return { quantity };
}
