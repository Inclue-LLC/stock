import { CATEGORIES, REGIONS, TYPES, characterList, paginate, productTotals, todayJst } from "../domain/inventory.js";
import { bulkBar, empty, html, icon, n, pager, selectCell, selectHeader, stockLegend, stockQty, wireBulk } from "../ui.js";
import { bulkDelete } from "./bulkDelete.js";
import { backupWorkbook, download, stockExportWorkbook } from "../xlsxWrite.js";

const NONE = ""; // キャラクター名なし

/** 絞り込みはキャラクター名だけ（複数選択可）。URL の ?c=…&c=… */
function filters(ctx) {
  return { q: "", includeZero: true, characters: ctx.params.getAll("c") };
}

/** キャラクター名 c を選択／解除した URL。 */
function toggleUrl(ctx, selected, c) {
  const next = selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c];
  const p = new URLSearchParams();
  for (const x of next) p.append("c", x);
  const s = p.toString();
  return `#${ctx.path}${s ? `?${s}` : ""}`;
}

export function render(ctx) {
  const f = filters(ctx);
  const items = productTotals(ctx.state, "", false, f.characters);
  const page = paginate(items, 1, Infinity); // 1ページに全件表示
  const chars = characterList(ctx.state);
  const hasNone = [...ctx.state.products.values()].some((p) => !p.character);
  const options = [...chars.map((c) => [c, c]), ...(hasNone ? [[NONE, "キャラクター名なし"]] : [])];

  const table = html`<table>
      <thead><tr>${selectHeader()}<th>キャラクター</th><th>商品</th><th>JANコード</th>
        ${CATEGORIES.map(([r, t]) => html`<th class="r">${REGIONS[r]}<br><span class="chip t-${t}">${TYPES[t]}</span></th>`)}
        <th class="r">合計</th></tr></thead>
      <tbody>${page.items.map(([p, ...qtys]) => html`<tr>
        ${selectCell(p)}
        <td>${p.character}</td>
        <td class="name"><a href="#/products/${p.id}">${p.name}</a></td>
        <td class="mono">${p.jan || "JANなし"}</td>
        ${qtys.slice(0, -1).map((q) => html`<td class="r ${q ? "" : "zero"}">${q ? n(q) : "–"}</td>`)}
        <td class="r">${stockQty(qtys[qtys.length - 1])}</td></tr>`)}</tbody>
    </table>`;

  return {
    title: "在庫一覧",
    actions: html`<button class="ghost" data-click="export">${icon("download")}Excel出力</button>
      <button class="ghost" data-click="backup" title="商品・拠点・在庫のすべてを Excel に保存します">${icon("download")}全データのバックアップ</button>`,
    body: html`<section class="card">
      <div class="toolbar char-filter">
        <span class="label">キャラクター</span>
        <a class="pick ${f.characters.length ? "" : "on"}" href="#/stocks">すべて</a>
        ${options.map(([value, label]) => html`<a class="pick ${f.characters.includes(value) ? "on" : ""}" href="${toggleUrl(ctx, f.characters, value)}">${label}</a>`)}
        <span class="grow"></span>
        ${stockLegend()}
      </div>
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
  async backup(ctx) {
    await download(await backupWorkbook(ctx.state), `stock_backup_${todayJst()}.xlsx`);
  },
  async export(ctx) {
    await download(await stockExportWorkbook(ctx.state, "product", filters(ctx)), "stock.xlsx");
  },
};
