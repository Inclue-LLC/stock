// Firestore エミュレータ（firestore.rules を適用）に対する結合テスト。
// 実行: npm run test:emulator（エミュレータを起動してから vitest を実行する）

import { initializeApp } from "firebase/app";
import {
  connectFirestoreEmulator, deleteDoc, doc, getDoc, getFirestore, setDoc, terminate, updateDoc,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { parseStockFile } from "../src/domain/files.js";
import {
  StockError, locationByName, productByJan, saveLocation, saveProduct, storeReport, validateBatch,
} from "../src/domain/inventory.js";
import { JAN_A, JAN_B, xlsx } from "./helpers.js";

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-stock";
const run = HOST ? describe : describe.skip;

let firestore;
let unsubscribe;
let state;

async function waitFor(pred) {
  for (let i = 0; i < 100; i++) {
    if (state && pred(state)) return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout");
}

async function upload(rows, { kind = "IN", location = "東京倉庫", date = "2026-10-14", zero = false } = {}) {
  const parsed = await parseStockFile("f.xlsx", await xlsx(rows));
  return db.createImport({ filename: "f.xlsx", source: parsed.source, kind, location_id: locationByName(state, location)?.id,
    zero_missing: zero, date, rows: parsed.rows, warnings: parsed.warnings });
}

const denied = (p) => expect(p).rejects.toMatchObject({ code: "permission-denied" });

run("Firestore（エミュレータ）", () => {
  beforeAll(() => {
    const [host, port] = HOST.split(":");
    firestore = getFirestore(initializeApp({ projectId: PROJECT, apiKey: "demo" }, "test"));
    connectFirestoreEmulator(firestore, host, Number(port));
    db.init(firestore);
  });

  beforeEach(async () => {
    unsubscribe?.();
    state = null;
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
    unsubscribe = db.subscribe((s) => (state = s));
    await db.mutate((W) => {
      for (const [name, region, type] of [["東京倉庫", "JP", "WAREHOUSE"], ["大阪委託店", "JP", "CONSIGNMENT"]]) {
        saveLocation(W, { name, region, type });
      }
      saveProduct(W, { jan: JAN_A, sku: "A-001", name: "商品A" });
    });
    await waitFor((s) => s.locations.size === 2 && s.products.size === 1);
  });

  afterAll(async () => {
    unsubscribe?.();
    await terminate(firestore);
  });

  it("ファイル取込 → 確認 → 反映 が保存され、二重反映できない", async () => {
    const id = await upload([["JANコード", "商品名", "数量"], [JAN_A, "商品A", 10], [JAN_B, "商品B", 4]]);
    const batch = await db.getImport(id);
    expect(validateBatch(state, batch).filter((p) => !p.errors.length)).toHaveLength(2);
    const r = await db.applyImport(id);
    expect(r).toEqual({ applied: 2, skipped: 0, zeroed: 0 });
    const s = await waitFor((x) => productByJan(x, JAN_B));
    const lid = locationByName(s, "東京倉庫").id;
    expect(s.stocks.get(lid).get(productByJan(s, JAN_A).id).q).toBe(10);
    expect((await db.getImport(id)).status).toBe("applied");
    await expect(db.applyImport(id)).rejects.toThrow(StockError);
    const { items } = await db.listHistory({ batchId: id });
    expect(items).toHaveLength(2);
    const prodHist = await db.listHistory({ productId: productByJan(s, JAN_A).id });
    expect(prodHist.items.map((m) => m.d)).toEqual([10]);
    expect((await db.listImports()).map((b) => b.id)).toContain(id);
  });

  it("納品（日付別）・販売・残数が店舗別明細に反映される", async () => {
    for (const [kind, date, rows] of [
      ["IN", "2025-09-26", [["JAN", "納品数"], [JAN_A, 20]]],
      ["IN", "2025-11-09", [["JAN", "納品数"], [JAN_A, 10]]],
      ["OUT", "2026-09-30", [["JAN", "販売数"], [JAN_A, 12]]],
      ["SET", "2026-09-30", [["JAN", "残数"], [JAN_A, 17]]],
    ]) {
      await db.applyImport(await upload(rows, { kind, date, location: "大阪委託店" }));
    }
    const s = await waitFor((x) => storeReport(x, locationByName(x, "大阪委託店").id).total("adjusted") === -1);
    const rep = storeReport(s, locationByName(s, "大阪委託店").id);
    expect(rep.delivery_dates).toEqual(["2025-09-26", "2025-11-09"]);
    expect([rep.total("delivered"), rep.total("sold"), rep.total("stock")]).toEqual([30, 12, 17]);
  });

  it("同時に反映しても在庫数がずれない（トランザクション）", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await upload([["JAN", "数量"], [JAN_A, 1]]));
    await Promise.all(ids.map((id) => db.applyImport(id)));
    const s = await waitFor((x) => x.stocks.get(locationByName(x, "東京倉庫").id)?.get(productByJan(x, JAN_A).id)?.q === 5);
    expect(s.stocks.get(locationByName(s, "東京倉庫").id).get(productByJan(s, JAN_A).id).q).toBe(5);
  });

  it("取消した取込は反映できない", async () => {
    const id = await upload([["JAN", "数量"], [JAN_A, 1]]);
    await db.updateImport(id, { status: "cancelled" });
    await expect(db.applyImport(id)).rejects.toThrow("処理済み");
  });

  it("ルール: 履歴の削除・書き換え、反映済み取込の変更、不正な catalog 更新はできない", async () => {
    const id = await upload([["JAN", "数量"], [JAN_A, 1]]);
    await db.applyImport(id);
    const { items } = await db.listHistory({ batchId: id });
    expect(items).toHaveLength(1);
    const anyHistory = (await import("firebase/firestore")).collection(firestore, "history");
    const { getDocs } = await import("firebase/firestore");
    const hdoc = (await getDocs(anyHistory)).docs[0].ref;
    await denied(deleteDoc(hdoc));
    await denied(updateDoc(hdoc, { movements: [] }));
    await denied(updateDoc(doc(firestore, "imports", id), { status: "pending" }));
    await denied(deleteDoc(doc(firestore, "imports", id)));
    const cat = (await getDoc(doc(firestore, "meta", "catalog"))).data();
    await denied(setDoc(doc(firestore, "meta", "catalog"), { ...cat, products: "x" }));
    await denied(setDoc(doc(firestore, "meta", "catalog"), { ...cat, version: cat.version + 1, evil: true }));
    await denied(deleteDoc(doc(firestore, "meta", "catalog")));
    await denied(setDoc(doc(firestore, "stocks", "no-such-location"), { items: {} }));
    await denied(setDoc(doc(firestore, "other", "x"), { a: 1 }));
  });
});
