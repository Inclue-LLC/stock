import { go, searchHash } from "../app.js";
import { CATEGORIES, REGIONS, TYPES, paginate, productTotals, sortedLocations, stockRows } from "../domain/inventory.js";
import { badge, bulkBar, empty, html, icon, locationOptions, n, pager, selectCell, selectHeader, stockLegend, stockQty, wireBulk } from "../ui.js";
import { bulkDelete } from "./bulkDelete.js";
import { download, stockExportWorkbook } from "../xlsxWrite.js";

function filters(ctx) {
  return {
    region: ctx.q("region") || null,
    type: ctx.q("type") || null,
    locationId: ctx.q("location_id") || null,
    q: ctx.q("q").trim(),
    includeZero: ctx.q("hide_zero") !== "1",
  };
}

export function render(ctx) {
  const f = filters(ctx);
  const view = ctx.q("view") === "location" ? "location" : "product"; // 拠点ごとの行表示は「拠点別」画面の明細から
  const items = view === "product" ? productTotals(ctx.state, f.q, !f.includeZero) : stockRows(ctx.state, f);
  const page = paginate(items, 1, Infinity); // 1ページに全件表示
  const locs = sortedLocations(ctx.state);

  const table = view === "product"
    ? html`<table>
        <thead><tr>${selectHeader()}<th>キャラクター</th><th>商品</th><th>ブランド</th><th>JANコード</th>
          ${CATEGORIES.map(([r, t]) => html`<th class="r">${REGIONS[r]}<br><span class="chip t-${t}">${TYPES[t]}</span></th>`)}
          <th class="r">合計</th></tr></thead>
        <tbody>${page.items.map(([p, ...qtys]) => html`<tr>
          ${selectCell(p)}
          <td>${p.character}</td>
          <td class="name"><a href="#/products/${p.id}">${p.name}</a>${p.sku ? html`<span class="sub">${p.sku}</span>` : ""}</td>
          <td>${p.brand}</td><td class="mono">${p.jan || "JANなし"}</td>
          ${qtys.slice(0, -1).map((q) => html`<td class="r ${q ? "" : "zero"}">${q ? n(q) : "–"}</td>`)}
          <td class="r">${stockQty(qtys[qtys.length - 1])}</td></tr>`)}</tbody>
      </table>`
    : html`<table>
        <thead><tr>${selectHeader()}<th>キャラクター</th><th>商品</th><th>JANコード</th><th>拠点</th><th>区分</th><th class="r">在庫数</th></tr></thead>
        <tbody>${page.items.map((s) => html`<tr>
          ${selectCell(s.product)}
          <td>${s.product.character}</td>
          <td class="name"><a href="#/products/${s.product.id}">${s.product.name}</a>${s.product.sku ? html`<span class="sub">${s.product.sku}</span>` : ""}</td>
          <td class="mono">${s.product.jan || "JANなし"}</td><td>${s.location.name}</td><td>${badge(s.location)}</td>
          <td class="r">${stockQty(s.q, s.product.unit)}</td></tr>`)}</tbody>
      </table>`;

  return {
    title: "在庫一覧",
    actions: html`<button class="ghost" data-click="export">${icon("download")}Excel出力</button>`,
    body: html`<section class="card">
      <form class="toolbar" data-action="search" data-search>
        <label class="search grow">${icon("search")}<input type="search" name="q" value="${f.q}" placeholder="JANコード・品番・商品名・キャラクター名で検索"></label>
        ${view === "location" ? html`
          <select name="region"><option value="">すべての地域</option>
            ${Object.entries(REGIONS).map(([k, v]) => html`<option value="${k}" ${f.region === k ? "selected" : ""}>${v}</option>`)}</select>
          <select name="type"><option value="">すべての種別</option>
            ${Object.entries(TYPES).map(([k, v]) => html`<option value="${k}" ${f.type === k ? "selected" : ""}>${v}</option>`)}</select>
          <select name="location_id">${locationOptions(locs, f.locationId, "すべての拠点")}</select>` : ""}
        <label class="check"><input type="checkbox" name="hide_zero" value="1" ${f.includeZero ? "" : "checked"}> 在庫0を隠す</label>
        <button class="ghost">絞り込み</button>
        ${stockLegend()}
      </form>
      ${page.items.length ? html`<form data-action="bulkDelete">${bulkBar()}<div class="table-wrap">${table}</div></form>${pager(page, ctx.urlWith)}`
        : empty("該当する在庫はありません。")}
    </section>`,
  };
}

export function mounted(ctx, root) {
  wireBulk(root);
}

export const actions = {
  bulkDelete,
  search(ctx, form) {
    go(searchHash(ctx, form, ["view"]));
  },
  async export(ctx) {
    const view = ctx.q("view") === "location" ? "location" : "product"; // 拠点ごとの行表示は「拠点別」画面の明細から
    await download(await stockExportWorkbook(ctx.state, view, filters(ctx)), "stock.xlsx");
  },
};
