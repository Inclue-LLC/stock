import { CATEGORIES, REGIONS, TYPES, characterList, currentQty, paginate, productTotals, sortedLocations, todayJst } from "../domain/inventory.js";
import { bulkBar, empty, html, icon, n, pager, qtyInput, selectCell, selectHeader, stockLegend, stockQty, wireBulk, wireQtyEdit } from "../ui.js";
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
        ${qtys.slice(0, -1).map((q, i) => html`<td class="r ${q ? "" : "zero"}"><button type="button" class="qty-open" data-pid="${p.id}"
          data-cat="${i}" title="クリックして拠点ごとの在庫数を編集">${q ? n(q) : "–"}</button></td>`)}
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
        <span class="hint">数字をクリックすると在庫数を編集できます</span>
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

/** 区分（日本・倉庫など）のセルをクリック → その区分の拠点ごとの在庫数を編集する小窓。 */
function openEditor(ctx, root, cell) {
  closeEditor(root);
  const state = ctx.state;
  const product = state.products.get(cell.dataset.pid);
  const [region, type] = CATEGORIES[Number(cell.dataset.cat)];
  const locs = sortedLocations(state).filter((l) => l.region === region && l.type === type);
  if (!product) return;
  const pop = document.createElement("form");
  pop.className = "qty-pop";
  pop.dataset.action = "saveQty";
  pop.innerHTML = String(html`
    <div class="qty-pop-head"><b>${product.name}</b><span class="muted">${REGIONS[region]}・${TYPES[type]}</span></div>
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
