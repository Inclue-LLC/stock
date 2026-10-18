// ダウンロード用の Excel（テンプレート・出力）を作る。ExcelJS は大きいので必要なときだけ読み込む。

import { REGIONS, TYPES, locationStockRows, productLocationTotals, sortedProducts, stockRows } from "./domain/inventory.js";

const FONT = "Meiryo UI";
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const HEADER = fill("FF1F4E9E");
const REQUIRED = fill("FFC0392B");
const AUTO = fill("FF7F8C8D");
const ERROR = fill("FFF8D7DA");
const thin = { style: "thin", color: { argb: "FFD0D5DD" } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const UNITS = ["個", "本", "枚", "箱", "袋", "セット", "ケース", "kg", "g", "L", "ml"];

async function workbook() {
  const mod = await import("exceljs");
  const ExcelJS = mod.default || mod;
  return new ExcelJS.Workbook();
}

export async function download(wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function header(ws, columns, fills) {
  const row = ws.getRow(1);
  columns.forEach(([title, width], i) => {
    const c = row.getCell(i + 1);
    c.value = title;
    c.font = { name: FONT, bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    c.fill = fills[i];
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = BORDER;
    ws.getColumn(i + 1).width = width;
  });
  row.height = 26;
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

/** JAN（8/13桁）の桁数・チェックデジット・重複を判定する数式。 */
function janCheckFormula(c, rng) {
  const cd13 = `MOD(10-MOD(SUMPRODUCT(MID(${c},{1,3,5,7,9,11},1)*1)+3*SUMPRODUCT(MID(${c},{2,4,6,8,10,12},1)*1),10),10)`;
  const cd8 = `MOD(10-MOD(3*SUMPRODUCT(MID(${c},{1,3,5,7},1)*1)+SUMPRODUCT(MID(${c},{2,4,6},1)*1),10),10)`;
  // COUNTIF は "4901..." を数値扱いして文字列セルと一致しないため、SUMPRODUCT で文字列比較する
  return `IF(${c}="","",IF(SUMPRODUCT(--(${rng}=${c}))>1,"JAN重複",`
    + `IFERROR(IF(LEN(${c})=13,IF(${cd13}=RIGHT(${c},1)*1,"OK","チェックデジット誤り"),`
    + `IF(LEN(${c})=8,IF(${cd8}=RIGHT(${c},1)*1,"OK","チェックデジット誤り"),"桁数エラー")),"数字以外を含む")))`;
}

export async function productMasterWorkbook(rows = 3000) {
  const wb = await workbook();
  const ws = wb.addWorksheet("商品マスタ");
  header(ws, [["JANコード", 18], ["キャラクター名", 18], ["商品名", 40], ["ブランド", 20], ["上代（税込）", 13], ["品番", 16],
    ["単位", 9], ["備考", 30], ["JANチェック（自動）", 20]],
  [REQUIRED, HEADER, REQUIRED, HEADER, HEADER, HEADER, HEADER, HEADER, AUTO]);
  const last = rows + 1;
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= 9; c++) {
      row.getCell(c).font = { name: FONT, size: 11 };
      row.getCell(c).border = BORDER;
    }
    row.getCell(1).numFmt = "@"; // JAN を文字列で保持（指数表記・先頭0落ち防止）
    row.getCell(5).numFmt = "#,##0";
    row.getCell(6).numFmt = "@";
    const chk = row.getCell(9);
    chk.value = { formula: janCheckFormula(`A${r}`, `$A$2:$A$${last}`) };
    chk.font = { name: FONT, size: 10, color: { argb: "FF595959" } };
    chk.alignment = { horizontal: "center" };
  }
  ws.autoFilter = `A1:I${last}`;
  ws.dataValidations.add(`A2:A${last}`, {
    type: "custom", formulae: ["OR(LEN(A2)=8,LEN(A2)=13)"], allowBlank: true, errorStyle: "warning",
    showErrorMessage: true, errorTitle: "JANコード", error: "JANコードは8桁または13桁の数字で入力してください。",
    showInputMessage: true, promptTitle: "JANコード", prompt: "8桁または13桁。先頭の0もそのまま入力できます。",
  });
  ws.dataValidations.add(`G2:G${last}`, { type: "list", formulae: [`"${UNITS.join(",")}"`], allowBlank: true,
    showErrorMessage: false });
  ws.dataValidations.add(`E2:E${last}`, { type: "whole", operator: "greaterThanOrEqual", formulae: [0], allowBlank: true,
    errorStyle: "warning", showErrorMessage: true, errorTitle: "上代", error: "上代は税込の金額（整数）で入力してください。" });
  ws.addConditionalFormatting({ ref: `A2:A${last}`, rules: [{ type: "expression", formulae: ['AND(A2<>"",I2<>"OK")'],
    style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFF8D7DA" } } } }] });
  ws.addConditionalFormatting({ ref: `I2:I${last}`, rules: [{ type: "expression", formulae: ['AND(I2<>"",I2<>"OK")'],
    style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFF8D7DA" } },
      font: { color: { argb: "FFC0392B" }, bold: true } } }] });
  productGuide(wb.addWorksheet("記入方法", { views: [{ showGridLines: false }] }));
  return wb;
}

function productGuide(ws) {
  [3, 20, 10, 26, 64].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getCell("B2").value = "商品マスタの記入方法";
  ws.getCell("B2").font = { name: FONT, size: 16, bold: true };
  const notes = [
    "「商品マスタ」シートの2行目から、1行に1商品ずつ入力してください。",
    "赤い見出しの列（JANコード・商品名）は必須です。青い見出しの列（キャラクター名・ブランド・上代など）は任意です。",
    "一覧はキャラクター名 → JANコードの順に並びます。",
    "JAN のない商品は、JANコードを空欄にして商品名だけで登録できます。",
    "灰色の「JANチェック（自動）」列は自動で判定します。「OK」以外が出た行は JAN を見直してください。",
    "JAN の重複・桁数・チェックデジットに問題がある行は、JAN のセルが赤くなります。",
    "入力後、在庫管理システムの「商品マスタ」→「Excel / CSV で一括登録」からこのファイルを取り込みます。",
    "すでに登録済みの JAN は、入力した項目で上書きされます（空欄の項目は変更されません）。",
  ];
  notes.forEach((t, i) => {
    const c = ws.getCell(4 + i, 2);
    c.value = `・${t}`;
    c.font = { name: FONT, size: 11 };
  });
  const top = 4 + notes.length + 1;
  ["項目", "必須", "記入例", "説明"].forEach((h, i) => {
    const c = ws.getCell(top, 2 + i);
    c.value = h;
    c.font = { name: FONT, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = HEADER;
    c.border = BORDER;
  });
  const items = [
    ["JANコード", "必須", "4580703202780", "8桁または13桁の数字。セルは文字列形式なので、先頭の0や13桁もそのまま入力できます。"],
    ["キャラクター名", "", "パム", "一覧の並び順（キャラクター名 → JANコード）と検索に使います。"],
    ["商品名", "必須", "むぎゅっとカードホルダー", "画面や帳票に表示される名前。"],
    ["ブランド", "", "Lovely MongMong", "店舗別画面でブランドごとにまとめて表示します。"],
    ["上代（税込）", "", "1650", "税込の販売価格（円）。販売金額・在庫金額の計算に使います。"],
    ["品番", "", "SK-001", "社内の品番・型番など。JAN の代わりに品番で取込することもできます。"],
    ["単位", "", "個", "リストから選択（個・本・箱・セット など）。リストにない単位も入力できます。空欄なら「個」。"],
    ["備考", "", "", "自由記入。"],
  ];
  items.forEach((row, r) => {
    row.forEach((v, i) => {
      const c = ws.getCell(top + 1 + r, 2 + i);
      c.value = v;
      c.font = { name: FONT, size: 11, color: { argb: v === "必須" ? "FFC0392B" : "FF000000" } };
      c.border = BORDER;
      c.alignment = { vertical: "middle", wrapText: true };
      if (i === 2) c.numFmt = "@";
    });
    ws.getRow(top + 1 + r).height = 34;
  });
}

/** 在庫取込・納品予定の取込テンプレート（JANコード・キャラクター名・商品名・数量・拠点）。 */
async function importTemplate(sheetName, rows) {
  const wb = await workbook();
  const ws = wb.addWorksheet(sheetName);
  header(ws, [["JANコード", 18], ["キャラクター名", 18], ["商品名", 36], ["上代（税込）", 13], ["数量", 10], ["拠点", 22]],
    [REQUIRED, HEADER, HEADER, HEADER, REQUIRED, HEADER]);
  for (let r = 2; r <= rows + 1; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= 6; c++) {
      row.getCell(c).font = { name: FONT, size: 11 };
      row.getCell(c).border = BORDER;
    }
    row.getCell(1).numFmt = "@";
    row.getCell(4).numFmt = "#,##0";
    row.getCell(5).numFmt = "#,##0";
  }
  return wb;
}

export const stockImportWorkbook = (rows = 1000) => importTemplate("在庫取込", rows);
export const planImportWorkbook = (rows = 1000) => importTemplate("納品予定", rows);

function headerRow(ws, titles) {
  ws.addRow(titles);
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = HEADER;
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

export async function stockExportWorkbook(state, view, filters) {
  const wb = await workbook();
  const ws = wb.addWorksheet("在庫");
  if (view === "location") {
    headerRow(ws, ["JANコード", "キャラクター名", "商品名", "地域", "種別", "拠点", "数量"]);
    for (const s of stockRows(state, filters)) {
      ws.addRow([s.product.jan, s.product.character, s.product.name, REGIONS[s.location.region], TYPES[s.location.type],
        s.location.name, s.q]);
    }
  } else {
    // 拠点ごとの列（見出しは「拠点名（日本・倉庫）」）
    const { locations, rows } = productLocationTotals(state, { q: filters.q, onlyInStock: !filters.includeZero, characters: filters.characters });
    headerRow(ws, ["JANコード", "キャラクター名", "商品名", "上代（税込）", ...locations.map((l) => `${l.name}（${REGIONS[l.region]}・${TYPES[l.type]}）`), "合計"]);
    for (const [p, ...qtys] of rows) ws.addRow([p.jan, p.character, p.name, p.price ?? null, ...qtys]);
    ws.getColumn(4).numFmt = "#,##0";
    for (let i = 0; i <= locations.length + 1; i++) ws.getColumn(4 + i).width = 16;
  }
  ws.getColumn(1).numFmt = "@";
  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 36;
  return wb;
}

export async function storeExportWorkbook(state, location, filters) {
  const wb = await workbook();
  const ws = wb.addWorksheet(location.name.slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
  headerRow(ws, ["キャラクター名", "商品名", "JANコード", "上代（税込）", "在庫数"]);
  for (const r of locationStockRows(state, location.id, filters)) {
    ws.addRow([r.product.character, r.product.name, r.product.jan, r.product.price ?? null, r.q]);
  }
  ws.getColumn(3).numFmt = "@";
  ws.getColumn(4).numFmt = "#,##0";
  ws.getColumn(5).numFmt = "#,##0";
  [18, 40, 16, 13, 10].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return wb;
}

/** 全データのバックアップ（商品・拠点・在庫）。 */
export async function backupWorkbook(state) {
  const wb = await workbook();
  const p = wb.addWorksheet("商品マスタ");
  headerRow(p, ["JANコード", "商品名", "キャラクター名", "ブランド", "上代（税込）", "備考"]);
  for (const x of sortedProducts(state)) p.addRow([x.jan, x.name, x.character, x.brand, x.price, x.note]);
  p.getColumn(1).numFmt = "@";
  const l = wb.addWorksheet("拠点");
  headerRow(l, ["拠点", "地域", "種別", "備考"]);
  for (const x of state.locations.values()) l.addRow([x.name, REGIONS[x.region], TYPES[x.type], x.note]);
  const s = wb.addWorksheet("在庫");
  headerRow(s, ["拠点", "JANコード", "商品名", "在庫数", "納品累計", "販売累計", "調整累計", "納品日別"]);
  for (const [lid, items] of state.stocks) {
    for (const [pid, e] of items) {
      const loc = state.locations.get(lid);
      const prod = state.products.get(pid);
      if (!loc || !prod) continue;
      s.addRow([loc.name, prod.jan, prod.name, e.q, e.del, e.sold, e.adj,
        Object.entries(e.dels).map(([d, q]) => `${d}:${q}`).join(" ")]);
    }
  }
  s.getColumn(2).numFmt = "@";
  return wb;
}

/** 納品予定の商品一覧（納品先ごと）。そのまま「納品予定」「在庫の更新」に取り込める列名。 */
export async function planExportWorkbook(state, plans) {
  const { planTitle, resolveLine } = await import("./domain/plans.js");
  const wb = await workbook();
  const ws = wb.addWorksheet("納品予定");
  headerRow(ws, ["納品先", "JANコード", "キャラクター名", "商品名", "上代（税込）", "数量"]);
  for (const plan of plans) {
    for (const l of plan.lines) {
      const [product] = resolveLine(state, l);
      ws.addRow([planTitle(state, plan), (product ? product.jan : l.jan) || "", product?.character || l.character || "",
        product ? product.name : l.name, product?.price ?? l.price ?? null, Number(l.quantity) || 0]);
    }
  }
  ws.getColumn(2).numFmt = "@";
  ws.getColumn(5).numFmt = "#,##0";
  ws.getColumn(6).numFmt = "#,##0";
  [24, 16, 18, 40, 13, 8].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return wb;
}
