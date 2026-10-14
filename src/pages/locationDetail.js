import { go, searchHash } from "../app.js";
import { storeReport } from "../domain/inventory.js";
import { badge, dateTime, empty, html, icon, n, pct, shortDate, yen } from "../ui.js";
import { download, storeExportWorkbook } from "../xlsxWrite.js";

function filters(ctx) {
  return { brand: ctx.q("brand"), q: ctx.q("q").trim() };
}

function groupBy(rows, key) {
  const groups = [];
  for (const r of rows) {
    const k = key(r);
    if (!groups.length || groups[groups.length - 1][0] !== k) groups.push([k, []]);
    groups[groups.length - 1][1].push(r);
  }
  return groups;
}

export function render(ctx) {
  const location = ctx.state.locations.get(ctx.args[0]);
  if (!location) return { title: "拠点が見つかりません", body: empty("この拠点は削除されたか、URL が正しくありません。", "#/locations", "拠点の一覧へ") };
  const f = filters(ctx);
  const rep = storeReport(ctx.state, location.id, f);
  const rows = rep.rows;
  const showDates = ctx.q("dates") !== "0";
  const dates = showDates ? rep.delivery_dates : [];
  const hasAdj = rows.some((r) => r.adjusted);
  const sum = (g, k) => g.reduce((a, r) => a + (r[k] || 0), 0);

  const body = rows.length ? html`<div class="table-wrap"><table class="report">
    <thead><tr>
      <th class="stick">商品</th><th class="r">上代</th>
      ${dates.map((d) => html`<th class="r date">${shortDate(d)}<br><span class="muted">納品</span></th>`)}
      <th class="r grp">納品 計</th><th class="r">販売</th>
      ${hasAdj ? html`<th class="r" title="在庫更新（残数報告など）による差分">調整</th>` : ""}
      <th class="r">在庫</th><th>消化率</th><th class="r">販売金額</th>
    </tr></thead>
    <tbody>${groupBy(rows, (r) => r.product.brand).map(([brand, group]) => html`
      ${!f.brand && rep.brands.length ? html`<tr class="group-row">
        <td class="stick" colspan="${2 + dates.length}"><b>${brand || "ブランド未設定"}</b> <span class="muted">${group.length}商品</span></td>
        <td class="r grp">${n(sum(group, "delivered"))}</td><td class="r">${n(sum(group, "sold"))}</td>
        ${hasAdj ? html`<td class="r">${n(sum(group, "adjusted"))}</td>` : ""}
        <td class="r">${n(sum(group, "stock"))}</td><td colspan="2"></td></tr>` : ""}
      ${group.map((r) => html`<tr>
        <td class="stick name"><a href="#/products/${r.product.id}">${r.product.name}</a><span class="sub mono">${r.product.jan || "JANなし"}</span></td>
        <td class="r muted">${r.product.price == null ? "–" : n(r.product.price)}</td>
        ${dates.map((d) => html`<td class="r date ${r.deliveries[d] ? "" : "zero"}">${r.deliveries[d] ? n(r.deliveries[d]) : ""}</td>`)}
        <td class="r grp"><b>${n(r.delivered)}</b></td>
        <td class="r">${r.sold ? n(r.sold) : "–"}</td>
        ${hasAdj ? html`<td class="r ${r.adjusted < 0 ? "neg" : ""}">${r.adjusted ? `${r.adjusted > 0 ? "+" : ""}${n(r.adjusted)}` : ""}</td>` : ""}
        <td class="r">${r.stock === 0 ? html`<span class="chip out">在庫切れ</span>` : html`<b>${n(r.stock)}</b>`}</td>
        <td class="st">${r.sell_through == null ? html`<span class="muted">–</span>` : html`<span class="meter sm"><i style="width:${Math.min(r.sell_through, 1) * 100}%" class="${r.sell_through >= 0.8 ? "hot" : ""}"></i></span><span class="pct">${pct(r.sell_through)}</span>`}</td>
        <td class="r">${r.sold ? yen(r.sales_amount) : "–"}</td>
      </tr>`)}`)}</tbody>
    <tfoot><tr>
      <td class="stick">合計 <span class="muted">${rows.length}商品</span></td><td></td>
      ${dates.map((d) => html`<td class="r date">${n(rep.deliveryTotal(d))}</td>`)}
      <td class="r grp">${n(rep.total("delivered"))}</td><td class="r">${n(rep.total("sold"))}</td>
      ${hasAdj ? html`<td class="r">${rep.total("adjusted") > 0 ? "+" : ""}${n(rep.total("adjusted"))}</td>` : ""}
      <td class="r">${n(rep.total("stock"))}</td><td>${pct(rep.sell_through)}</td><td class="r">${yen(rep.total("sales_amount"))}</td>
    </tr></tfoot>
  </table></div>` : empty("この拠点にはまだ在庫・納品の記録がありません。", `#/imports?location_id=${location.id}`, "ファイルから更新する");

  return {
    title: location.name,
    sub: html`${badge(location)}　最終更新 ${location.updated_at ? dateTime(location.updated_at) : "なし"}`,
    actions: html`<button class="ghost" data-click="export">${icon("download")}Excel出力</button>
      <a class="btn" href="#/imports?location_id=${location.id}">${icon("upload")}在庫を更新</a>`,
    body: html`
    <div class="metrics">
      <div class="metric"><span>納品数</span><b>${n(rep.total("delivered"))}</b></div>
      <div class="metric"><span>販売数</span><b>${n(rep.total("sold"))}</b></div>
      <div class="metric"><span>在庫数</span><b>${n(rep.total("stock"))}</b></div>
      <div class="metric"><span>消化率</span><b>${pct(rep.sell_through)}</b>
        <i class="meter"><i style="width:${(rep.sell_through || 0) * 100}%"></i></i></div>
      <div class="metric"><span>販売金額（上代）</span><b>${yen(rep.total("sales_amount"))}</b></div>
      <div class="metric"><span>在庫金額（上代）</span><b>${yen(rep.total("stock_amount"))}</b></div>
    </div>
    <section class="card">
      <form class="toolbar" data-action="search" data-search>
        ${rep.brands.length ? html`<div class="tabs">
          <a href="${ctx.urlWith({ brand: null })}" class="${f.brand ? "" : "active"}">すべて</a>
          ${rep.brands.map((b) => html`<a href="${ctx.urlWith({ brand: b })}" class="${f.brand === b ? "active" : ""}">${b}</a>`)}
        </div>` : ""}
        <label class="search grow">${icon("search")}<input type="search" name="q" value="${f.q}" placeholder="商品名・JANコードで検索"></label>
        ${rep.delivery_dates.length ? html`<label class="check"><input type="checkbox" name="dates" value="0" ${showDates ? "" : "checked"} data-autosubmit> 納品日ごとの列を隠す</label>` : ""}
        <button class="ghost">検索</button>
      </form>
      ${body}
    </section>
    <p class="hint">消化率 ＝ 販売数 ÷（販売数 ＋ 在庫数）。調整 ＝「在庫数を上書き」で数量を合わせたときの差分（ロス・棚差、記録より前の納品など）。</p>`,
  };
}

export const actions = {
  search(ctx, form) {
    go(searchHash(ctx, form, ["brand"]));
  },
  async export(ctx) {
    const location = ctx.state.locations.get(ctx.args[0]);
    await download(await storeExportWorkbook(ctx.state, location, filters(ctx)), "store_report.xlsx");
  },
};
