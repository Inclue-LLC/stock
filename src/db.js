// Firestore への保存。読み取り回数を抑えるため、データはまとめて保存する。
//
//   meta/catalog        { products: {id: 商品}, locations: {id: 拠点}, version }   … 商品マスタ・拠点（1件）
//   stocks/{拠点id}      { items: {商品id: {q, del, sold, adj, dels}} }             … 拠点ごとの在庫（拠点数ぶん）
//   imports/{id}        取込ファイルの内容と状態（確認画面 → 反映）
//   history/{id}        入出庫履歴（1回の操作ぶんをまとめて保存。追記のみ）
//
// 画面を開いたときの読み取りは「catalog 1件 ＋ 拠点数」だけで、以降は変更があった分だけ届く。
// 変更はすべてトランザクションで行い、複数の人が同時に操作しても在庫数がずれないようにする。

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { StockError, applyBatch, emptyState, newId, working } from "./domain/inventory.js";
import { applyPlan } from "./domain/plans.js";

const HISTORY_CHUNK = 400; // 1件の履歴ドキュメントに入れる最大件数（1MB 制限対策）
const MAX_ROWS_JSON = 900_000;

let db = null;
let state = emptyState();
let catalogVersion = 0;
let ready = { catalog: false, stocks: false, plans: false };

export function init(firestore) {
  db = firestore;
}

export function getState() {
  return state;
}

const catalogRef = () => doc(db, "meta", "catalog");
const stockRef = (lid) => doc(db, "stocks", lid);

function catalogToState(data, stocks) {
  const s = emptyState();
  for (const [id, p] of Object.entries(data?.products || {})) s.products.set(id, { ...p, id });
  for (const [id, l] of Object.entries(data?.locations || {})) s.locations.set(id, { ...l, id });
  s.stocks = stocks;
  return s;
}

function stockItems(data) {
  return new Map(Object.entries(data?.items || {}).map(([pid, v]) => [pid, { q: 0, del: 0, sold: 0, adj: 0, dels: {}, ...v }]));
}

/** データの変化を監視する。onChange(state) が初回読み込み後と変化のたびに呼ばれる。 */
export function subscribe(onChange, onError) {
  let catalogData = null;
  const stocks = new Map();
  const plans = new Map();
  const emit = () => {
    if (ready.catalog && ready.stocks && ready.plans) {
      state = catalogToState(catalogData, new Map(stocks));
      state.plans = new Map(plans);
      onChange(state);
    }
  };
  const u1 = onSnapshot(catalogRef(), (snap) => {
    catalogData = snap.exists() ? snap.data() : null;
    catalogVersion = catalogData?.version || 0;
    ready.catalog = true;
    emit();
  }, onError);
  const u2 = onSnapshot(collection(db, "stocks"), (snap) => {
    for (const change of snap.docChanges()) {
      if (change.type === "removed") stocks.delete(change.doc.id);
      else stocks.set(change.doc.id, stockItems(change.doc.data()));
    }
    ready.stocks = true;
    emit();
  }, onError);
  const u3 = onSnapshot(collection(db, "plans"), (snap) => {
    for (const change of snap.docChanges()) {
      if (change.type === "removed") plans.delete(change.doc.id);
      else plans.set(change.doc.id, planFromData(change.doc.id, change.doc.data()));
    }
    ready.plans = true;
    emit();
  }, onError);
  return () => {
    u1();
    u2();
    u3();
    ready = { catalog: false, stocks: false, plans: false };
  };
}

function catalogData(W, version) {
  const products = {};
  for (const [id, p] of W.products) {
    const { id: _, ...rest } = p;
    products[id] = rest;
  }
  const locations = {};
  for (const [id, l] of W.locations) {
    const { id: _, ...rest } = l;
    locations[id] = rest;
  }
  return { products, locations, version, updated_at: serverTimestamp() };
}

/**
 * データを変更する。fn(W, extra) で作業コピー W を書き換える（例外を投げると何も保存しない）。
 * options.reads: 追加で読むドキュメント（例: 取込ドキュメント）。fn の第2引数に [snapshot...] で渡る。
 * fn は { result, writes: [[ref, data]], history: {batch_id, filename, source} } を返してよい。
 */
export async function mutate(fn, { reads = [] } = {}) {
  return runTransaction(db, async (tx) => {
    const catSnap = await tx.get(catalogRef());
    const cat = catSnap.exists() ? catSnap.data() : null;
    const stocks = new Map();
    for (const lid of Object.keys(cat?.locations || {})) {
      const snap = await tx.get(stockRef(lid));
      if (snap.exists()) stocks.set(lid, stockItems(snap.data()));
    }
    const extra = [];
    for (const ref of reads) extra.push(await tx.get(ref));
    const W = working(catalogToState(cat, stocks));
    const out = (await fn(W, extra)) || {};

    if (W.catalogDirty) tx.set(catalogRef(), catalogData(W, (cat?.version || 0) + 1));
    for (const lid of W.dirtyStocks) {
      const items = {};
      for (const [pid, s] of W.stocks.get(lid) || []) items[pid] = s;
      tx.set(stockRef(lid), { items, updated_at: serverTimestamp() });
    }
    for (const lid of W.deletedStocks || []) tx.delete(stockRef(lid));
    for (const [ref, data] of out.writes || []) tx.set(ref, data);
    const meta = out.history || {};
    for (let i = 0; i < W.movements.length; i += HISTORY_CHUNK) {
      const chunk = W.movements.slice(i, i + HISTORY_CHUNK);
      tx.set(doc(db, "history", newId()), {
        created_at: serverTimestamp(), batch_id: meta.batch_id || null, filename: meta.filename || "",
        source: meta.source || "MANUAL", seq: i / HISTORY_CHUNK,
        location_ids: [...new Set(chunk.map((m) => m.l))], product_ids: [...new Set(chunk.map((m) => m.p))],
        movements: chunk,
      });
    }
    return out.result;
  });
}

// ---- 納品予定（plans） ----------------------------------------------------------------

const PLAN_FIELDS = ["title", "location_id", "source_id", "due", "status", "memo", "lines", "done_date", "applied"];
export const planRef = (id) => doc(db, "plans", id);

function planFromData(id, d) {
  return { id, title: "", location_id: "", source_id: "", due: "", status: "todo", memo: "", lines: [], done_date: null,
    applied: false, ...d, created_at: d.created_at?.toDate?.() || null, updated_at: d.updated_at?.toDate?.() || null };
}

function planData(plan) {
  const data = {};
  for (const k of PLAN_FIELDS) data[k] = plan[k] ?? null;
  data.lines = (plan.lines || []).map((l) => ({ product_id: l.product_id || null, jan: l.jan || "", name: l.name || "",
    quantity: Number(l.quantity) || 0 }));
  return data;
}

/** 納品予定を保存する（新規なら ID を返す）。 */
export async function savePlan(plan) {
  const id = plan.id || newId();
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(planRef(id));
    tx.set(planRef(id), { ...planData(plan), created_at: snap.exists() ? snap.data().created_at : serverTimestamp(),
      updated_at: serverTimestamp() });
  });
  return id;
}

export async function deletePlan(id) {
  await runTransaction(db, async (tx) => tx.delete(planRef(id)));
}

/** 納品予定を完了にする。apply なら在庫に反映する（1回だけ）。 */
export async function completePlan(id, date, apply) {
  return mutate((W, [snap]) => {
    if (!snap.exists()) throw new StockError("納品予定が見つかりません");
    const plan = planFromData(id, snap.data());
    if (plan.applied && apply) throw new StockError("この納品予定はすでに在庫に反映済みです");
    const result = apply ? applyPlan(W, plan, date) : { quantity: 0 };
    const data = { ...planData({ ...plan, status: "done", done_date: date, applied: plan.applied || apply }),
      created_at: snap.data().created_at, updated_at: serverTimestamp() };
    return { result, writes: [[planRef(id), data]],
      history: { filename: `納品予定: ${plan.title || plan.due}`, source: "MANUAL" } };
  }, { reads: [planRef(id)] });
}

// ---- 取込（imports） ---------------------------------------------------------------

export const importRef = (id) => doc(db, "imports", id);

export async function createImport({ filename, source, kind, location_id, zero_missing, date, rows, warnings }) {
  const rowsJson = JSON.stringify(rows);
  if (rowsJson.length > MAX_ROWS_JSON) throw new Error("ファイルの行数が多すぎます。ファイルを分けて取り込んでください");
  const id = newId();
  await runTransaction(db, async (tx) => {
    tx.set(importRef(id), {
      filename, source, kind, location_id: location_id || null, status: "pending", zero_missing: !!zero_missing,
      date, rows_json: rowsJson, row_count: rows.length, warnings: warnings.slice(0, 200), created_at: serverTimestamp(),
    });
  });
  return id;
}

export function batchFromSnap(snap) {
  if (!snap.exists()) return null;
  const d = snap.data();
  return { id: snap.id, ...d, rows: JSON.parse(d.rows_json || "[]"), created_at: d.created_at?.toDate?.() || new Date() };
}

export async function getImport(id) {
  return batchFromSnap(await getDoc(importRef(id)));
}

export async function listImports(n = 50) {
  const snap = await getDocs(query(collection(db, "imports"), orderBy("created_at", "desc"), limit(n)));
  return snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, ...x, rows_json: undefined, created_at: x.created_at?.toDate?.() || new Date() };
  });
}

/** 取込の状態・拠点を変える（pending のときだけ）。 */
export async function updateImport(id, changes) {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(importRef(id));
    if (!snap.exists() || snap.data().status !== "pending") return;
    tx.set(importRef(id), { ...snap.data(), ...changes });
  });
}

/** 取込を反映する（確認画面の内容を、その時点の最新の在庫で検証し直してから反映）。 */
export async function applyImport(id) {
  return mutate((W, [snap]) => {
    const batch = batchFromSnap(snap);
    if (!batch) throw new StockError("取込が見つかりません");
    const result = applyBatch(W, batch);
    return { result, writes: [[importRef(id), { ...snap.data(), status: "applied" }]],
      history: { batch_id: id, filename: batch.filename, source: batch.source } };
  }, { reads: [importRef(id)] });
}

// ---- 履歴（history） ---------------------------------------------------------------

function flatten(docs) {
  const out = [];
  for (const d of docs) {
    const x = d.data();
    const created = x.created_at?.toDate?.() || new Date();
    x.movements.forEach((m, i) => out.push({ ...m, created_at: created, source: x.source, batch_id: x.batch_id,
      filename: x.filename, order: [created.getTime(), x.seq || 0, i] }));
  }
  out.sort((a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1] || b.order[2] - a.order[2]);
  return out;
}

/** 履歴を新しい順に返す。{ items, truncated } */
export async function listHistory({ productId = null, batchId = null, maxDocs = 60 } = {}) {
  const col = collection(db, "history");
  let q;
  if (productId) q = query(col, where("product_ids", "array-contains", productId), orderBy("created_at", "desc"), limit(maxDocs));
  else if (batchId) q = query(col, where("batch_id", "==", batchId));
  else q = query(col, orderBy("created_at", "desc"), limit(maxDocs));
  let snap;
  try {
    snap = await getDocs(q);
  } catch (e) {
    if (!productId) throw e;
    // インデックスが未作成の場合は並べ替えなしで読む
    snap = await getDocs(query(col, where("product_ids", "array-contains", productId), limit(maxDocs)));
  }
  let items = flatten(snap.docs);
  if (productId) items = items.filter((m) => m.p === productId);
  return { items, truncated: !batchId && snap.docs.length >= maxDocs };
}
