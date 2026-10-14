import { go } from "../app.js";
import { mutate } from "../db.js";
import { deleteProduct } from "../domain/inventory.js";
import { selectedProducts } from "../ui.js";

/** チェックした商品をまとめて削除する（各拠点の在庫からも消える）。 */
export async function bulkDelete(ctx, form) {
  const products = selectedProducts(form, ctx.state);
  if (!products.length) return;
  const names = products.slice(0, 5).map((p) => `・${p.name}`).join("\n") + (products.length > 5 ? `\n ほか${products.length - 5}件` : "");
  if (!confirm(`選択した ${products.length}件の商品を削除しますか？\n${names}\n\nすべての拠点の在庫からも削除されます（元に戻せません）。`)) return;
  await mutate((W) => {
    for (const p of products) if (W.products.has(p.id)) deleteProduct(W, p.id);
  });
  go(ctx.urlWith(), { msg: `${products.length}件の商品を削除しました` });
}
