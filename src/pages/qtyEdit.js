// 在庫数の手入力（在庫一覧・拠点別の在庫一覧で共通）。

import { go } from "../app.js";
import { saveQuantities } from "../db.js";
import { StockError } from "../domain/inventory.js";
import { changedQuantities } from "../ui.js";

/** 画面の action: 変更した在庫数を保存する。el はボタンまたはフォーム。 */
export async function saveQtyAction(ctx, el) {
  const container = el.closest(".qty-pop") || (el.tagName === "FORM" ? el : el.closest("form"));
  const changes = changedQuantities(container);
  if (!changes.length) throw new StockError("変更された在庫数はありません");
  for (const c of changes) {
    if (!Number.isInteger(c.quantity) || c.quantity < 0) throw new StockError("在庫数は 0 以上の整数で入力してください");
  }
  const count = await saveQuantities(changes);
  go(location.hash, { msg: count ? `${count}件の在庫数を保存しました` : "在庫数は変わっていません" });
}
