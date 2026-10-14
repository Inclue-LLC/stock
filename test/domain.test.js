import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseCsvText, parseProductFile, parseStockFile } from "../src/domain/files.js";
import {
  StockError, applyBatch, importProducts, missingStocks, productByJan, productTotals, productsByName,
  sortedLocations, stockRows, storeReport, validateBatch, working, paginate, locationByName, saveProduct,
} from "../src/domain/inventory.js";
import { JanError, normalize } from "../src/domain/jan.js";
import { readXlsx } from "../src/domain/xlsxRead.js";
import { JAN_A, JAN_B, JAN_C, JAN_D, commit, jan, move, qty, seeded, xlsx } from "./helpers.js";

// ---- JAN -----------------------------------------------------------------------

describe("JAN", () => {
  it.each([
    ["4912345678904", "4912345678904"],
    [4912345678904, "4912345678904"],
    ["４９１２３４５６７８９０４", "4912345678904"],
    ["49000016", "49000016"],
    ["012345678905", "0012345678905"], // 先頭の0が落ちた12桁
    ["4912-3456-78904", "4912345678904"],
  ])("normalize(%s)", (v, expected) => expect(normalize(v)).toBe(expected));

  it.each(["4912345678905", "12345", "4.91235E+12", "ABC", "", 4912345678904.5])("rejects %s", (v) => {
    expect(() => normalize(v)).toThrow(JanError);
  });
});

// ---- ファイル読み取り --------------------------------------------------------------

async function batchFrom(filename, data, kind, state, location = null, extra = {}) {
  const parsed = await parseStockFile(filename, data);
  return { filename, source: parsed.source, kind, status: "pending", date: "2026-10-14",
    location_id: location ? locationByName(state, location).id : null, rows: parsed.rows, warnings: parsed.warnings,
    zero_missing: false, ...extra };
}

function apply(state, batch) {
  const W = working(state);
  const r = applyBatch(W, batch);
  return [commit(W), r, W];
}

describe("xlsx の読み取り", () => {
  it("数式の計算結果（0 や空文字）・共有文字列・ふりがな・インライン文字列を正しく読む", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["JAN", "数量", "計算"]);
    ws.getCell("A2").value = "4900000000016";
    ws.getCell("B2").value = { formula: "1-1", result: 0 };
    ws.getCell("C2").value = { formula: "\"\"", result: "" };
    const data = Buffer.from(await wb.xlsx.writeBuffer());
    const [[name, table]] = readXlsx(data);
    expect(name).toBe("S");
    expect(table[1]).toEqual(["4900000000016", 0, null]);
  });

  it("ふりがな（rPh）を商品名に含めない", () => {
    // 実際の Excel が保存する sharedStrings の形を最小限で再現する

    const files = {
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="在庫" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8('<sst><si><t>商品名</t></si><si><t>手のひら&amp;ぬいぐるみ</t><rPh sb="0" eb="1"><t>テノヒラ</t></rPh></si></sst>'),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="B1" t="s"><v>0</v></c></row>'
        + '<row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3" t="inlineStr"><is><t>メモ</t></is></c><c r="D3" t="b"><v>1</v></c></row></sheetData></worksheet>'),
    };
    const [[, table]] = readXlsx(zipSync(files));
    expect(table[0]).toEqual([null, "商品名"]);
    expect(table[1]).toEqual([]);
    expect(table[2]).toEqual([null, "手のひら&ぬいぐるみ", "メモ", true]);
  });
});

describe("在庫取込", () => {
  it("Excel: 見出しの自動検出・新規商品・拠点列・合計行・JAN 誤り", async () => {
    let st = seeded();
    const data = await xlsx([
      ["JANコード", "商品名", "数量", "拠点"],
      [JAN_A, "商品A", "１２", "上海倉庫"],
      [Number(JAN_B), "商品B", 5, null],
      [JAN_B, "商品B", 3, null],
      [JAN_C, "商品C", 1, "存在しない店"],
      [JAN_D, null, 1, null], // 未登録・商品名なし
      ["4900000000048", "誤り", 1, null],
      ["合計", null, 21, null],
    ], 2);
    const batch = await batchFrom("in.xlsx", data, "IN", st, "東京倉庫");
    const preview = validateBatch(st, batch);
    expect(preview).toHaveLength(6);
    expect(preview.map((p) => p.errors.length > 0)).toEqual([false, false, false, true, true, true]);
    expect(preview[1].product).toBeNull(); // 新規商品
    const [after, r] = apply(st, batch);
    expect(r).toEqual({ applied: 3, skipped: 3, zeroed: 0 });
    expect(qty(after, JAN_A, "上海倉庫")).toBe(12);
    expect(qty(after, JAN_B, "東京倉庫")).toBe(8);
    expect(productByJan(after, JAN_C)).toBeNull();
    expect(() => applyBatch(working(after), { ...batch, status: "applied" })).toThrow(StockError);
  });

  it("品番・商品名でも照合できる（JANなし商品は商品名で新規登録）", async () => {
    let st = seeded();
    const data = await xlsx([["品番", "商品名", "数量"], ["A-001", "", 6], ["Z-999", "", 1], ["", "ふわふわぬいぐるみ", 87], ["", "合計", 99]]);
    const batch = await batchFrom("sku.xlsx", data, "IN", st, "東京倉庫");
    const preview = validateBatch(st, batch);
    expect(preview[1].errors[0]).toContain("品番「Z-999」の商品は未登録です");
    const [after] = apply(st, batch);
    expect(qty(after, JAN_A, "東京倉庫")).toBe(6);
    const fuwa = productsByName(after, "ふわふわぬいぐるみ")[0];
    expect(fuwa.jan).toBeNull();
    expect(after.stocks.get(locationByName(after, "東京倉庫").id).get(fuwa.id).q).toBe(87);
  });

  it("CSV（中国語の見出し・GBK）で在庫数を上書き", async () => {
    const st = move(seeded(), "IN", 50, "北京委託店");
    const gbk = Buffer.from("ccf5c2eb2cc6b7c3fb2cbfe2b4e60a", "hex"); // "条码,品名,库存\n"（GBK）
    const data = Buffer.concat([gbk, Buffer.from(`${JAN_A},A,30\n`)]);
    const batch = await batchFrom("count.csv", data, "SET", st, "北京委託店");
    const [after] = apply(st, batch);
    expect(qty(after, JAN_A, "北京委託店")).toBe(30);
  });

  it("CSV: Shift_JIS・引用符・改行を読む", async () => {
    const sjis = Buffer.from("8f a4 95 69 96 bc 2c 90 94 97 ca".replace(/ /g, ""), "hex"); // 商品名,数量
    const data = Buffer.concat([sjis, Buffer.from(`\r\n"A, ""B"""," 1,200 "\r\n`)]);
    const parsed = await parseStockFile("s.csv", data);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].name).toBe('A, "B"');
    expect(parsed.rows[0].quantity).toBe(1200);
    expect(parseCsvText("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("販売（減算）で在庫不足の行はエラーになり、反映されない", async () => {
    let st = move(seeded(), "IN", 3);
    const data = await xlsx([["JAN", "販売数"], [JAN_A, 2], [JAN_A, 2]]);
    const batch = await batchFrom("out.xlsx", data, "OUT", st, "東京倉庫");
    expect(validateBatch(st, batch)[1].errors[0]).toContain("在庫不足");
    const [after] = apply(st, batch);
    expect(qty(after, JAN_A, "東京倉庫")).toBe(1);
  });

  it("ファイルにない商品の在庫を0にする（他の拠点は変えない）", async () => {
    let st = seeded();
    const W = working(st);
    saveProduct(W, { jan: JAN_B, name: "商品B" });
    st = commit(W);
    st = move(move(move(st, "IN", 5, "大阪委託店"), "IN", 3, "大阪委託店", JAN_B), "IN", 9, "東京倉庫", JAN_B);
    const data = await xlsx([["JAN", "在庫数"], [JAN_A, 4]]);
    const batch = await batchFrom("all.xlsx", data, "SET", st, "大阪委託店", { zero_missing: true });
    expect(missingStocks(st, batch, validateBatch(st, batch))).toHaveLength(1);
    const [after, r] = apply(st, batch);
    expect(r.zeroed).toBe(1);
    expect(qty(after, JAN_A, "大阪委託店")).toBe(4);
    expect(qty(after, JAN_B, "大阪委託店")).toBe(0);
    expect(qty(after, JAN_B, "東京倉庫")).toBe(9);
  });

  it("PDF（表）を読む", async () => {
    const st = seeded();
    const batch = await batchFrom("slip.pdf", readFileSync("test/fixtures/table.pdf"), "IN", st, "大阪委託店");
    expect(batch.rows.map((r) => [r.jan, r.quantity])).toEqual([[JAN_A, 7], [JAN_D, 2]]);
    const [after] = apply(st, batch);
    expect(qty(after, JAN_D, "大阪委託店")).toBe(2);
  });

  it("PDF（表なし）はテキスト行から推定する", async () => {
    const parsed = await parseStockFile("lines.pdf", readFileSync("test/fixtures/lines.pdf"));
    expect(parsed.rows.map((r) => [r.jan, r.quantity])).toEqual([[JAN_A, 5], [JAN_D, 3]]);
    expect(parsed.warnings[0]).toContain("テキスト行から推定");
  });

  it("対応していない形式", async () => {
    await expect(parseStockFile("a.txt", Buffer.from("x"))).rejects.toThrow("対応形式");
  });
});

// ---- 商品マスタ -------------------------------------------------------------------

describe("商品マスタの一括登録", () => {
  it("新規・更新（空欄は上書きしない）・JAN 誤り・JAN なし", async () => {
    const st = seeded();
    const data = await xlsx([
      ["JANコード", "商品名", "ブランド", "上代（税込）", "品番", "単位"],
      [Number(JAN_B), "商品B", "Studio Haneul", "1,650", "B-002", "箱"],
      [JAN_A, "商品A（改）", null, null, null, null],
      ["4900000000031", "不正", null, null, null, null],
      [null, "ふわふわぬいぐるみ", "Studio Haneul", 500, null, null],
      [null, "ふわふわぬいぐるみ", null, 550, null, null],
    ]);
    const parsed = await parseProductFile("m.xlsx", data);
    const W = working(st);
    const r = importProducts(W, parsed.rows);
    expect(r.created).toBe(2);
    expect(r.updated).toBe(1);
    expect(r.errors).toHaveLength(1);
    const b = productByJan(W, JAN_B);
    expect([b.unit, b.brand, b.price]).toEqual(["箱", "Studio Haneul", 1650]);
    const a = productByJan(W, JAN_A);
    expect([a.name, a.sku]).toEqual(["商品A（改）", "A-001"]);
    const f = productsByName(W, "ふわふわぬいぐるみ");
    expect(f).toHaveLength(1);
    expect(f[0].price).toBe(550);
  });

  it("JAN の重複登録はできない", () => {
    const W = working(seeded());
    expect(() => saveProduct(W, { jan: JAN_A, name: "dup" })).toThrow("すでに登録");
  });
});

// ---- 一覧・店舗別明細 ----------------------------------------------------------------

describe("集計", () => {
  it("商品別（4区分）と拠点別", () => {
    const st = move(move(seeded(), "IN", 10), "IN", 7, "北京委託店");
    const [[p, ...q]] = productTotals(st);
    expect(p.jan).toBe(JAN_A);
    expect(q).toEqual([10, 0, 0, 7, 17]);
    expect(stockRows(st, { region: "CN" }).map((s) => s.location.name)).toEqual(["北京委託店"]);
    expect(sortedLocations(st).map((l) => l.name)).toEqual(["東京倉庫", "大阪委託店", "上海倉庫", "北京委託店"]);
  });

  it("ページ分け", () => {
    const W = working(seeded());
    for (let i = 0; i < 120; i++) saveProduct(W, { jan: jan(`490100${String(i).padStart(6, "0")}`), name: `商品${i}` });
    const page = paginate(productTotals(commit(W)), 3, 50);
    expect([page.total, page.start, page.end, page.pages]).toEqual([121, 101, 121, 3]);
    const all = paginate(productTotals(commit(W)), 1, Infinity);
    expect([all.items.length, all.start, all.end, all.pages]).toEqual([121, 1, 121, 1]);
  });

  it("店舗別明細: 納品（日付別）・販売・調整・消化率・金額・ブランド", async () => {
    let st = seeded();
    const W = working(st);
    saveProduct(W, { jan: JAN_B, name: "商品B", brand: "Lovely MongMong", price: 1650 });
    st = commit(W);
    const load = async (kind, date, rows) => {
      const data = await xlsx(rows);
      const batch = await batchFrom("f.xlsx", data, kind, st, "大阪委託店", { date });
      [st] = apply(st, batch);
    };
    await load("IN", "2025-09-26", [["JANコード", "商品名", "ブランド", "上代（税込）", "数量"],
      [JAN_A, "商品A", "Studio Haneul", 330, 20], [JAN_B, "商品B", null, null, 10]]);
    await load("IN", "2025-11-09", [["JAN", "納品数"], [JAN_A, 10]]);
    await load("OUT", "2026-09-30", [["JAN", "販売数"], [JAN_A, 12], [JAN_B, 4]]);
    await load("SET", "2026-09-30", [["JAN", "残数"], [JAN_A, 17]]);
    const a = productByJan(st, JAN_A);
    expect([a.brand, a.price]).toEqual(["Studio Haneul", 330]); // 取込ファイルからマスタの空欄を補完
    const lid = locationByName(st, "大阪委託店").id;
    const rep = storeReport(st, lid);
    expect(rep.delivery_dates).toEqual(["2025-09-26", "2025-11-09"]);
    const ra = rep.rows.find((r) => r.product.jan === JAN_A);
    expect([ra.delivered, ra.sold, ra.adjusted, ra.stock]).toEqual([30, 12, -1, 17]);
    expect(ra.deliveries).toEqual({ "2025-09-26": 20, "2025-11-09": 10 });
    expect(ra.sell_through).toBeCloseTo(12 / 29);
    expect(ra.sales_amount).toBe(12 * 330);
    expect(rep.brands).toEqual(["Lovely MongMong", "Studio Haneul"]);
    expect(storeReport(st, lid, { brand: "Lovely MongMong" }).rows.map((r) => r.product.jan)).toEqual([JAN_B]);
  });
});

// ---- キャラクター名 ----------------------------------------------------------------

describe("キャラクター名", () => {
  it("商品マスタ・在庫取込で読み取り、一覧はキャラクター名 → JANコード順に並ぶ", async () => {
    const st = seeded();
    const data = await xlsx([
      ["JANコード", "商品名", "キャラクター名"],
      [JAN_D, "ステッカー", "ポポ"],
      [JAN_B, "缶バッジ", "タルト"],
      [JAN_C, "ぬいぐるみ", "タルト"],
      [null, "JANなし商品", "パム"],
    ]);
    const W = working(st);
    importProducts(W, (await parseProductFile("m.xlsx", data)).rows);
    // 在庫取込: 「キャラ」列でもマスタの空欄を補う（既存の商品A）
    const stock = await xlsx([["JAN", "キャラ", "数量"], [JAN_A, "パム", 3]]);
    const batch = { ...(await batchFrom("s.xlsx", stock, "IN", commit(W), "東京倉庫")) };
    applyBatch(W, batch);
    const order = productTotals(commit(W)).map(([p]) => `${p.character}:${p.jan || "なし"}`);
    // キャラクター名（文字コード順）→ JAN 順。JAN なしは同じキャラクターの最後
    expect(order).toEqual([`タルト:${JAN_B}`, `タルト:${JAN_C}`, `パム:${JAN_A}`, "パム:なし", `ポポ:${JAN_D}`]);
    expect(productByJan(W, JAN_A).character).toBe("パム");
    expect(productTotals(commit(W), "タルト")).toHaveLength(2); // キャラクター名で検索できる
  });

  it("商品マスタのテンプレートにキャラクター名の列があり、そのまま取り込める", async () => {
    const { productMasterWorkbook, stockImportWorkbook } = await import("../src/xlsxWrite.js");
    const wb = await productMasterWorkbook(5);
    const ws = wb.getWorksheet("商品マスタ");
    expect(ws.getRow(1).values.slice(1, 9)).toEqual(["JANコード", "キャラクター名", "商品名", "ブランド", "上代（税込）", "品番", "単位", "備考"]);
    ws.getCell("A2").value = JAN_B;
    ws.getCell("B2").value = "タルト";
    ws.getCell("C2").value = "商品B";
    ws.getCell("E2").value = 1650;
    const parsed = await parseProductFile("t.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.rows).toHaveLength(1);
    expect([parsed.rows[0].character, parsed.rows[0].price]).toEqual(["タルト", 1650]);
    const sw = (await stockImportWorkbook(3)).getWorksheet("在庫取込");
    expect(sw.getRow(1).values.slice(1, 7)).toEqual(["JANコード", "キャラクター名", "商品名", "数量", "拠点", "備考"]);
  });
});

describe("拠点別の在庫一覧", () => {
  it("キャラクター名 → JANコード順・在庫0は既定で非表示・検索", async () => {
    const { locationStockRows, saveProduct: save, working: w } = await import("../src/domain/inventory.js");
    let st = seeded();
    const W = w(st);
    save(W, { jan: JAN_B, name: "缶バッジ", character: "タルト" });
    save(W, { jan: JAN_C, name: "ぬいぐるみ", character: "パム" });
    st = commit(W);
    st = move(move(move(st, "IN", 2, "大阪委託店", JAN_C), "IN", 3, "大阪委託店", JAN_B), "IN", 1, "大阪委託店", JAN_A);
    st = move(st, "OUT", 1, "大阪委託店", JAN_A);
    const lid = locationByName(st, "大阪委託店").id;
    expect(locationStockRows(st, lid).map((r) => [r.product.jan, r.q])).toEqual([[JAN_B, 3], [JAN_C, 2]]);
    expect(locationStockRows(st, lid, { includeZero: true }).map((r) => r.product.jan)).toEqual([JAN_B, JAN_C, JAN_A]);
    expect(locationStockRows(st, lid, { q: "パム" }).map((r) => r.product.jan)).toEqual([JAN_C]);
  });
});
