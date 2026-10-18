import { go } from "../app.js";
import { applyImport, getImport, updateImport } from "../db.js";
import { IMPORT_KIND_LABELS, SOURCES, missingStocks, sortedLocations, validateBatch } from "../domain/inventory.js";
import { empty, html, icon, locationOptions, n, yen } from "../ui.js";

export const live = false;
const STATUS = { pending: "未反映", applied: "反映済", cancelled: "取消" };

export async function render(ctx) {
  const batch = await getImport(ctx.args[0]);
  if (!batch) return { title: "取込が見つかりません", body: empty("URL が正しくありません。", "#/imports", "在庫の更新へ") };
  const preview = batch.status === "pending" ? validateBatch(ctx.state, batch) : [];
  const missing = preview.length ? missingStocks(ctx.state, batch, preview) : [];
  const ok = preview.filter((p) => !p.errors.length).length;
  const newProducts = preview.filter((p) => !p.errors.length && !p.product).length;
  const diffs = preview.filter((p) => !p.errors.length && p.name_diff).length;
  const priceDiffs = preview.filter((p) => !p.errors.length && p.price_diff).length;
  const warnings = batch.warnings || [];
  return {
    title: "更新内容の確認",
    sub: batch.filename,
    body: html`
    <section class="card"><div class="card-body"><div class="keyvals">
      <span>反映のしかた <b>${IMPORT_KIND_LABELS[batch.kind]}</b></span>
      <span>日付 <b>${batch.date || "–"}</b></span>
      <span>形式 <b>${SOURCES[batch.source]}</b></span>
      <span>行数 <b>${batch.row_count}</b></span>
      <span>状態 <span class="chip s-${batch.status}">${STATUS[batch.status]}</span></span>
    </div></div></section>
    ${warnings.slice(0, 20).map((w) => html`<div class="alert warn">${icon("alert")}<span>${w}</span></div>`)}
    ${warnings.length > 20 ? html`<div class="alert warn">ほか ${warnings.length - 20} 件の警告</div>` : ""}
    ${batch.status === "pending" ? html`
    <section class="card">
      <div class="card-head"><h2>反映内容</h2>
        <form data-action="setLocation" class="toolbar"><span class="hint">「拠点」列が空の行の拠点</span>
          <select name="location_id" data-autosubmit>${locationOptions(sortedLocations(ctx.state), batch.location_id, "未指定")}</select></form>
      </div>
      <form data-action="apply">
      ${diffs ? html`<div class="card-body name-diff-bar"><div class="alert warn" style="margin:0">${icon("alert")}<span>
        登録済みの商品と<b>商品名が違う行が ${diffs}件</b>あります。行ごとに、登録済みの商品名のままにするか、ファイルの商品名に変えるかを選んでください。
        <span class="setall"><button type="button" class="ghost sm" data-setall="keep">すべて登録済みのまま</button>
        <button type="button" class="ghost sm" data-setall="file">すべてファイルの商品名にする</button></span></span></div></div>` : ""}
      ${priceDiffs ? html`<div class="card-body name-diff-bar"><div class="alert warn" style="margin:0">${icon("alert")}<span>
        登録済みの商品と<b>上代が違う行が ${priceDiffs}件</b>あります。行ごとに、登録済みの上代のままにするか、ファイルの上代に変えるかを選んでください。
        <span class="setall"><button type="button" class="ghost sm" data-setall="keep" data-scope="price-choice">すべて登録済みのまま</button>
        <button type="button" class="ghost sm" data-setall="file" data-scope="price-choice">すべてファイルの上代にする</button></span></span></div></div>` : ""}
      ${preview.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>商品</th><th>JANコード</th><th class="r">上代（税込）</th><th>拠点</th><th class="r">数量</th><th class="r">現在</th><th class="r">反映後</th><th>確認</th></tr></thead>
        <tbody>${preview.map((p) => html`<tr class="${p.errors.length ? "row-err" : !p.product ? "row-new" : p.name_diff || p.price_diff ? "row-diff" : ""}">
          <td class="muted">${p.index + 1}</td>
          <td class="name">${p.name_diff && !p.errors.length ? html`<div class="name-choice">
              <label><input type="radio" name="rn_${p.index}" value="keep" checked><span><small>登録済み</small>${p.product.name}</span></label>
              <label><input type="radio" name="rn_${p.index}" value="file"><span><small>ファイル</small>${p.name}</span></label>
            </div>` : p.product ? p.product.name : p.name}${p.sku ? html`<span class="sub">${p.sku}</span>` : ""}</td>
          <td class="mono">${p.jan_code || p.jan || "JANなし"}</td>
          <td class="r nowrap">${p.price_diff && !p.errors.length ? html`<div class="name-choice price-choice">
              <label><input type="radio" name="rp_${p.index}" value="keep" checked><span><small>登録済み</small>${yen(p.product.price)}</span></label>
              <label><input type="radio" name="rp_${p.index}" value="file"><span><small>ファイル</small>${yen(p.price)}</span></label>
            </div>` : yen(p.product?.price ?? p.price ?? null)}</td>
          <td>${p.location ? p.location.name : p.location_name || ""}</td>
          <td class="r"><b>${p.quantity == null ? "?" : n(p.quantity)}</b></td>
          <td class="r muted">${p.current == null ? "" : n(p.current)}</td>
          <td class="r">${p.after == null ? "" : n(p.after)}</td>
          <td>${p.errors.length ? html`<span class="neg">${p.errors.join(" / ")}</span>`
            : !p.product ? html`<span class="chip s-pending">新規商品</span>`
            : p.name_diff || p.price_diff ? html`<span class="chip s-pending">${[p.name_diff && "商品名", p.price_diff && "上代"].filter(Boolean).join("・")}が違う</span>`
            : html`<span class="chip s-applied">OK</span>`}</td>
        </tr>`)}</tbody></table></div>` : empty("読み取れた行はありません。")}
      ${missing.length ? html`<div class="card-body" style="border-top:1px solid var(--border)"><details class="more">
        <summary>ファイルにない商品 ${missing.length}件の在庫を0にします（クリックで一覧）</summary>
        <ul class="steps" style="margin-top:8px">${missing.slice(0, 200).map((s) =>
          html`<li>${s.location.name}：${s.product.name} <span class="mono muted">${s.product.jan || ""}</span>（現在 ${n(s.q)}）</li>`)}</ul>
      </details></div>` : ""}
      <div class="card-body actions" style="border-top:1px solid var(--border)">
        <button class="lg" ${ok ? "" : "disabled"}>${icon("check")}${ok}件を反映する${newProducts ? `（新規商品 ${newProducts}件）` : ""}${missing.length ? `・${missing.length}件を0に` : ""}</button>
        <button class="ghost lg" data-click="cancel">取り消す</button>
        ${ok < preview.length ? html`<span class="hint">エラーの ${preview.length - ok} 件は反映されません</span>` : ""}
      </div>
      </form>
    </section>` : html`<section class="card"><div class="card-body actions">
      ${batch.status === "applied" ? html`<a class="btn" href="#/movements?batch_id=${batch.id}">反映された履歴を見る</a>` : ""}
      <a class="btn ghost" href="#/imports">在庫の更新に戻る</a></div></section>`}`,
  };
}

export function mounted(ctx, root) {
  // 「すべて〜」で商品名（または上代）の選択をまとめて切り替える
  for (const b of root.querySelectorAll("[data-setall]")) {
    b.addEventListener("click", () => {
      const scope = b.dataset.scope ? `.${b.dataset.scope}` : ".name-choice:not(.price-choice)";
      for (const r of root.querySelectorAll(`${scope} input[value="${b.dataset.setall}"]`)) r.checked = true;
    });
  }
}

export const actions = {
  async setLocation(ctx, form) {
    await updateImport(ctx.args[0], { location_id: new FormData(form).get("location_id") || null });
    go(`#/imports/${ctx.args[0]}`);
  },
  async apply(ctx, form) {
    const id = ctx.args[0];
    const picked = (prefix) => [...new FormData(form)].filter(([k, v]) => k.startsWith(prefix) && v === "file").map(([k]) => Number(k.slice(3)));
    const r = await applyImport(id, { renames: picked("rn_"), reprices: picked("rp_") });
    let msg = `${r.applied}件を反映しました${r.skipped ? `（エラー ${r.skipped}件はスキップ）` : ""}`;
    if (r.renamed) msg += `。商品名を ${r.renamed}件変更しました`;
    if (r.repriced) msg += `。上代を ${r.repriced}件変更しました`;
    if (r.zeroed) msg += `。ファイルにない ${r.zeroed}件を0にしました`;
    go(`#/imports/${id}`, { msg });
  },
  async cancel(ctx) {
    await updateImport(ctx.args[0], { status: "cancelled" });
    go("#/imports", { msg: "取込を取り消しました" });
  },
};
