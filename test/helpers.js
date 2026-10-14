import ExcelJS from "exceljs";
import { checkDigit } from "../src/domain/jan.js";
import { applyMovement, emptyState, locationByName, productByJan, saveLocation, saveProduct, working } from "../src/domain/inventory.js";

export const JAN_A = "4900000000016"; // 品番 A-001 / 商品A
export const JAN_B = "4900000000023";
export const JAN_C = "4900000000030";
export const JAN_D = "4900000000047";

export function jan(body12) {
  return body12 + checkDigit(body12);
}

/** 作業コピーを確定した状態として返す（保存したのと同じ扱い）。 */
export function commit(W) {
  return { products: W.products, locations: W.locations, stocks: W.stocks };
}

export function seeded() {
  const W = working(emptyState());
  for (const [name, region, type] of [["東京倉庫", "JP", "WAREHOUSE"], ["大阪委託店", "JP", "CONSIGNMENT"],
    ["上海倉庫", "CN", "WAREHOUSE"], ["北京委託店", "CN", "CONSIGNMENT"]]) {
    saveLocation(W, { name, region, type });
  }
  saveProduct(W, { jan: JAN_A, sku: "A-001", name: "商品A" });
  return commit(W);
}

export function move(state, kind, quantity, loc = "東京倉庫", code = JAN_A, date = null) {
  const W = working(state);
  applyMovement(W, { productId: productByJan(W, code).id, locationId: locationByName(W, loc).id, kind, quantity, date });
  return commit(W);
}

export function qty(state, code, loc) {
  const p = productByJan(state, code);
  const l = locationByName(state, loc);
  return p && l ? state.stocks.get(l.id)?.get(p.id)?.q ?? null : null;
}

export async function xlsx(rows, titleRows = 0, sheetName = "Sheet1") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (let i = 0; i < titleRows; i++) ws.addRow(["タイトル"]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
