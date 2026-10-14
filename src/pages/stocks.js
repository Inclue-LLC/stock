import { REGIONS, TYPES, characterList, currentQty, paginate, productLocationTotals, todayJst } from "../domain/inventory.js";
import { bulkBar, empty, html, icon, n, pager, qtyInput, raw, selectCell, stockLegend, stockQty, wireBulk, wireQtyEdit } from "../ui.js";
import { saveQtyAction } from "./qtyEdit.js";
import { bulkDelete } from "./bulkDelete.js";
import { backupWorkbook, download, stockExportWorkbook } from "../xlsxWrite.js";

const NONE = ""; // キャラクター名なし

// 在庫数の編集の小窓を開いている間は、他の人の更新で描き直さない（閉じると次の更新から反映）
export const live = () => !document.querySelector(".qty-pop");

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
  const { locations, rows: items } = productLocationTotals(ctx.state, { characters: f.characters });
  const page = paginate(items, 1, Infinity); // 1ページに全件表示
  const chars = characterList(ctx.state);
  const hasNone = [...ctx.state.products.values()].some((p) => !p.character);
  const options = [...chars.map((c) => [c, c]), ...(hasNone ? [[NONE, "キャラクター名なし"]] : [])];
  // 見出し1段目: 地域・種別のまとまり（日本・倉庫 など）。2段目: 拠点名
  const groups = [];
  const starts = new Set(); // まとまりの最初の列（左に区切り線）
  locations.forEach((l, i) => {
    const last = groups.at(-1);
    if (last && last.region === l.region && last.type === l.type) last.span++;
    else {
      groups.push({ region: l.region, type: l.type, span: 1 });
      starts.add(i);
    }
  });
  const first = (i) => (starts.has(i) ? "grp-start" : "");

  const table = html`<table class="by-location">
      <thead>
        <tr>${raw('<th class="sel" rowspan="2"></th>')}<th rowspan="2">キャラクター</th><th rowspan="2">商品</th><th rowspan="2">JANコード</th>
          ${groups.map((g) => html`<th class="grp grp-start" colspan="${g.span}">${REGIONS[g.region]} <span class="chip t-${g.type}">${TYPES[g.type]}</span></th>`)}
          <th class="r grp-start" rowspan="2">合計</th></tr>
        <tr>${locations.map((l, i) => html`<th class="r loc ${first(i)}">${l.name}</th>`)}</tr>
      </thead>
      <tbody>${page.items.map(([p, ...qtys]) => html`<tr>
        ${selectCell(p)}
        <td>${p.character}</td>
        <td class="name"><a href="#/products/${p.id}">${p.name}</a></td>
        <td class="mono">${p.jan || "JANなし"}</td>
        ${qtys.slice(0, -1).map((q, i) => html`<td class="r ${q ? "" : "zero"} ${first(i)}"><button type="button" class="qty-open" data-pid="${p.id}"
          data-lid="${locations[i].id}" title="クリックして在庫数を編集（${locations[i].name}）">${q ? n(q) : "–"}</button></td>`)}
        <td class="r grp-start">${stockQty(qtys[qtys.length - 1])}</td></tr>`)}</tbody>
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
        <span class="hint">数字をクリックすると在庫数を編集できます。拠点名は「拠点マスタ」で変更できます</span>
        ${stockLegend()}
      </div>
      ${page.items.length ? html`<form data-action="bulkDelete">${bulkBar()}<div class="table-wrap">${table}</div></form>${pager(page, ctx.urlWith)}`
        : empty("該当する在庫はありません。")}
    </section>`,
  };
}

export function mounted(ctx, root) {
  wireBulk(root);
  root.querySelector(".table-wrap")?.addEventListener("click", (e) => {
    const b = e.target.closest(".qty-open");
    if (b) openEditor(ctx, root, b);
  });
}

/** 拠点の在庫数をクリック → その拠点の在庫数を編集する小窓。 */
function openEditor(ctx, root, cell) {
  closeEditor(root);
  const state = ctx.state;
  const product = state.products.get(cell.dataset.pid);
  const loc = state.locations.get(cell.dataset.lid);
  if (!product || !loc) return;
  const locs = [loc];
  const pop = document.createElement("form");
  pop.className = "qty-pop";
  pop.dataset.action = "saveQty";
  pop.innerHTML = String(html`
    <div class="qty-pop-head"><b>${product.name}</b><span class="muted">${REGIONS[loc.region]}・${TYPES[loc.type]}</span></div>
    ${locs.length ? html`<div class="qty-pop-rows">${locs.map((l) => html`<label><span>${l.name}</span>
      ${qtyInput(product.id, l.id, currentQty(state, l.id, product.id), `${l.name}の在庫数`)}</label>`)}</div>`
      : html`<p class="hint">この区分の拠点がありません。拠点マスタで追加してください。</p>`}
    <div class="qty-pop-actions">
      ${locs.length ? html`<button type="submit" class="sm">${icon("check")}保存</button>` : ""}
      <button type="button" class="ghost sm" data-close>閉じる</button>
    </div>`);
  root.querySelector(".content").append(pop);
  // セルの下に表示（ページ上の位置。画面の端からはみ出さないように）
  const r = cell.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${window.scrollX + Math.max(8, Math.min(r.right - w, document.documentElement.clientWidth - w - 8))}px`;
  const below = r.bottom + 6 + pop.offsetHeight <= window.innerHeight - 8;
  pop.style.top = `${window.scrollY + (below ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6))}px`;
  wireQtyEdit(pop);
  pop.querySelector("[data-close]").addEventListener("click", () => closeEditor(root));
  pop.querySelector(".qty-input")?.focus();
  const onKey = (e) => e.key === "Escape" && closeEditor(root);
  const onDown = (e) => !pop.contains(e.target) && !e.target.closest(".qty-open") && closeEditor(root);
  document.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onDown);
  pop.cleanup = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("mousedown", onDown);
  };
}

function closeEditor(root) {
  for (const p of root.querySelectorAll(".qty-pop")) {
    p.cleanup?.();
    p.remove();
  }
}

export const actions = {
  bulkDelete,
  saveQty: saveQtyAction,
  async backup(ctx) {
    await download(await backupWorkbook(ctx.state), `stock_backup_${todayJst()}.xlsx`);
  },
  async export(ctx) {
    await download(await stockExportWorkbook(ctx.state, "product", filters(ctx)), "stock.xlsx");
  },
};
