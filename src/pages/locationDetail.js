import { go, searchHash } from "../app.js";
import { locationStockRows, paginate } from "../domain/inventory.js";
import { badge, bulkBar, dateTime, empty, html, icon, n, pager, selectCell, selectHeader, stockLegend, stockQty, wireBulk } from "../ui.js";
import { bulkDelete } from "./bulkDelete.js";
import { download, storeExportWorkbook } from "../xlsxWrite.js";

function filters(ctx) {
  return { q: ctx.q("q").trim(), includeZero: ctx.q("hide_zero") !== "1" };
}

export function render(ctx) {
  const location = ctx.state.locations.get(ctx.args[0]);
  if (!location) return { title: "拠点が見つかりません", body: empty("この拠点は削除されたか、URL が正しくありません。", "#/locations", "拠点別の一覧へ") };
  const f = filters(ctx);
  const rows = locationStockRows(ctx.state, location.id, f);
  const total = rows.reduce((a, r) => a + r.q, 0);
  const page = paginate(rows, 1, Infinity); // 1ページに全件表示
  return {
    title: location.name,
    sub: html`${badge(location)}　最終更新 ${location.updated_at ? dateTime(location.updated_at) : "なし"}`,
    actions: html`<button class="ghost" data-click="export">${icon("download")}Excel出力</button>
      <a class="btn" href="#/imports?location_id=${location.id}">${icon("upload")}在庫を更新</a>`,
    body: html`<section class="card">
      <form class="toolbar" data-action="search" data-search>
        <label class="search grow">${icon("search")}<input type="search" name="q" value="${f.q}" placeholder="JANコード・品番・商品名・キャラクター名で検索"></label>
        <label class="check"><input type="checkbox" name="hide_zero" value="1" ${f.includeZero ? "" : "checked"}> 在庫0を隠す</label>
        <button class="ghost">絞り込み</button>
        ${stockLegend()}
      </form>
      ${page.items.length ? html`<form data-action="bulkDelete">${bulkBar()}<div class="table-wrap"><table>
        <thead><tr>${selectHeader()}<th>キャラクター</th><th>商品</th><th>JANコード</th><th class="r">在庫数</th></tr></thead>
        <tbody>${page.items.map(({ product: p, q }) => html`<tr>
          ${selectCell(p)}
          <td>${p.character}</td>
          <td class="name"><a href="#/products/${p.id}">${p.name}</a>${p.sku ? html`<span class="sub">${p.sku}</span>` : ""}</td>
          <td class="mono">${p.jan || "JANなし"}</td>
          <td class="r">${stockQty(q, p.unit)}</td></tr>`)}</tbody>
        <tfoot><tr><td></td><td colspan="3">合計 <span class="muted">${n(rows.length)}商品</span></td><td class="r">${n(total)}</td></tr></tfoot>
      </table></div></form>${pager(page, ctx.urlWith)}`
      : empty("該当する在庫はありません。", `#/imports?location_id=${location.id}`, "ファイルから更新する")}
    </section>`,
  };
}

export function mounted(ctx, root) {
  wireBulk(root);
}

export const actions = {
  bulkDelete,
  search(ctx, form) {
    go(searchHash(ctx, form));
  },
  async export(ctx) {
    const location = ctx.state.locations.get(ctx.args[0]);
    await download(await storeExportWorkbook(ctx.state, location, filters(ctx)), "location_stock.xlsx");
  },
};
