import { go, searchHash } from "../app.js";
import { listHistory } from "../db.js";
import { KINDS, REGIONS, SOURCES, TYPES, matches, paginate, sortedLocations } from "../domain/inventory.js";
import { badge, dateTime, delta, empty, html, icon, locationOptions, n, pager } from "../ui.js";

export const live = false;

export async function render(ctx) {
  const st = ctx.state;
  const f = { region: ctx.q("region"), type: ctx.q("type"), location_id: ctx.q("location_id"), source: ctx.q("source"),
    q: ctx.q("q").trim(), batch_id: ctx.q("batch_id") };
  const { items, truncated } = await listHistory({ batchId: f.batch_id || null, maxDocs: 60 });
  const rows = items
    .map((m) => ({ ...m, product: st.products.get(m.p), location: st.locations.get(m.l) }))
    .filter((m) => m.product && m.location
      && (!f.region || m.location.region === f.region) && (!f.type || m.location.type === f.type)
      && (!f.location_id || m.location.id === f.location_id) && (!f.source || m.source === f.source)
      && matches(m.product, f.q));
  const page = paginate(rows, Number(ctx.q("page")) || 1, 100);
  const opt = (obj, cur, blank) => html`<option value="">${blank}</option>${Object.entries(obj).map(([k, v]) =>
    html`<option value="${k}" ${cur === k ? "selected" : ""}>${v}</option>`)}`;
  return {
    title: "入出庫履歴",
    body: html`<section class="card">
      <form class="toolbar" data-action="search" data-search>
        <label class="search grow">${icon("search")}<input type="search" name="q" value="${f.q}" placeholder="JANコード・品番・商品名"></label>
        <select name="region">${opt(REGIONS, f.region, "すべての地域")}</select>
        <select name="type">${opt(TYPES, f.type, "すべての種別")}</select>
        <select name="location_id">${locationOptions(sortedLocations(st), f.location_id, "すべての拠点")}</select>
        <select name="source">${opt(SOURCES, f.source, "すべての入力元")}</select>
        <button class="ghost">絞り込み</button>
      </form>
      ${f.batch_id ? html`<p class="hint" style="padding:8px 20px 0;margin:0">1回の取込で反映された履歴のみ表示しています。<a href="#/movements">解除</a></p>` : ""}
      ${truncated ? html`<p class="hint" style="padding:8px 20px 0;margin:0">最近の更新を表示しています（古い履歴は商品ごとの画面で確認できます）。</p>` : ""}
      ${page.items.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>区分</th><th>商品</th><th>拠点</th><th class="r">増減</th><th class="r">変更後</th><th>入力元</th><th>備考</th></tr></thead>
        <tbody>${page.items.map((m) => html`<tr>
          <td class="nowrap muted">${m.dt || dateTime(m.created_at).slice(0, 10)}</td>
          <td><span class="chip k">${KINDS[m.k]}</span></td>
          <td class="name"><a href="#/products/${m.product.id}">${m.product.name}</a><span class="sub mono">${m.product.jan || "JANなし"}</span></td>
          <td>${m.location.name}<br>${badge(m.location)}</td>
          <td class="r">${delta(m.d)}</td><td class="r">${n(m.a)}</td>
          <td>${m.batch_id ? html`<a href="#/imports/${m.batch_id}">${SOURCES[m.source]}</a>` : SOURCES[m.source]}</td>
          <td class="muted">${m.n}</td></tr>`)}</tbody></table></div>${pager(page, ctx.urlWith)}` : empty("履歴はありません。")}
    </section>`,
  };
}

export const actions = {
  search(ctx, form) {
    go(searchHash(ctx, form, ["batch_id"]));
  },
};
