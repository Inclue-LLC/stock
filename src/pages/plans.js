import { go } from "../app.js";
import { createPlans, savePlan } from "../db.js";
import { parseStockFile } from "../domain/files.js";
import { StockError, sortedLocations, todayJst } from "../domain/inventory.js";
import { PLAN_STATUS, dueClass, dueLabel, planQuantity, plansFromRows, sortPlans } from "../domain/plans.js";
import { dropzone, empty, html, icon, locationOptions, n } from "../ui.js";
import { download, planImportWorkbook } from "../xlsxWrite.js";

const COLUMNS = [["todo", "予定"], ["doing", "準備中"], ["done", "完了"]];
const DONE_LIMIT = 30; // 完了の列は新しい順にこの件数まで

function card(ctx, p) {
  const dest = ctx.state.locations.get(p.location_id);
  const src = p.source_id ? ctx.state.locations.get(p.source_id) : null;
  const next = p.status === "todo" ? html`<button type="button" class="ghost sm" data-click="setStatus" data-id="${p.id}" data-status="doing">準備中にする ›</button>`
    : p.status === "doing" ? html`<a class="btn sm" href="#/plans/${p.id}?complete=1">完了にする ›</a>` : "";
  return html`<div class="plan-card due-${dueClass(p) || "none"}">
    <a class="plan-title" href="#/plans/${p.id}">${p.title || "（タイトルなし）"}</a>
    <div class="plan-meta">${icon("pin")}<span>${dest ? dest.name : "納品先未設定"}${src ? html` <span class="muted">← ${src.name}</span>` : ""}</span></div>
    <div class="plan-meta"><span class="due">${p.status === "done" ? `完了 ${(p.done_date || "").slice(5).replace("-", "/")}` : `予定 ${dueLabel(p)}`}</span></div>
    <div class="plan-meta muted">明細 ${p.lines.length}件・${n(planQuantity(p))}点${p.applied ? html`　<span class="chip s-applied">在庫反映済</span>` : ""}</div>
    ${next ? html`<div class="plan-actions">${next}</div>` : ""}
  </div>`;
}

export function render(ctx) {
  const locationId = ctx.q("location_id");
  const all = [...(ctx.state.plans?.values() || [])].filter((p) => !locationId || p.location_id === locationId || p.source_id === locationId);
  const cols = COLUMNS.map(([status, label]) => {
    let items = all.filter((p) => p.status === status);
    items = status === "done"
      ? items.sort((a, b) => (b.done_date || "").localeCompare(a.done_date || "")).slice(0, DONE_LIMIT)
      : sortPlans(items);
    return [status, label, items];
  });
  const locs = sortedLocations(ctx.state);
  const overdue = all.filter((p) => dueClass(p) === "overdue").length;
  return {
    title: "納品予定",
    sub: "これから納品する予定を、予定 → 準備中 → 完了 の順に管理します。完了時に在庫へ反映できます",
    body: html`
    <section class="card">
      <div class="card-head"><h2>Excel から納品予定を作成</h2><a href="#" data-click="template">${icon("download")} テンプレート</a></div>
      <form data-action="import" class="card-body form">
        <div class="grid half" style="gap:16px">
          ${dropzone("ファイルを選択、またはドラッグ＆ドロップ", "列: JANコード・キャラクター名・商品名・数量・拠点（.xlsx / .csv）", ".xlsx,.xlsm,.csv")}
          <div class="form">
            <div class="row">
              <label class="field"><span>予定日</span><input type="date" name="due" value="${todayJst()}" required></label>
              <label class="field"><span>タイトル（空欄ならファイル名）</span><input name="title" placeholder="例：11月追加納品"></label>
            </div>
            <label class="field"><span>納品先（「拠点」列が空の行に使います）</span>
              <select name="location_id">${locationOptions(locs, locationId || null, "ファイル内の「拠点」列を使う")}</select></label>
            <label class="field"><span>出荷元（任意。完了時にここから在庫を減らします）</span>
              <select name="source_id">${locationOptions(locs, null, "なし（新規入荷など）")}</select></label>
          </div>
        </div>
        <p class="hint" style="margin:0">拠点が複数ある場合は、拠点ごとに別の納品予定になります。</p>
        <div><button>${icon("upload")}読み込んで納品予定を作成</button></div>
      </form>
    </section>
    <form class="toolbar" data-action="filter" data-search style="margin-bottom:16px">
      <select name="location_id" data-autosubmit>${locationOptions(locs, locationId || null, "すべての拠点")}</select>
      ${overdue ? html`<span class="chip out">予定日を過ぎた予定 ${overdue}件</span>` : ""}
      <span class="legend"><span class="dot overdue"></span>予定日を過ぎた　<span class="dot soon"></span>7日以内</span>
    </form>
    ${all.length ? html`<div class="board">${cols.map(([status, label, items]) => html`
      <section class="board-col col-${status}">
        <h2>${label} <span class="muted">${items.length}</span></h2>
        ${items.length ? items.map((p) => card(ctx, p)) : html`<div class="board-empty">なし</div>`}
      </section>`)}</div>`
      : html`<section class="card">${empty("納品予定はまだありません。上のフォームから Excel を取り込んで作成してください。")}</section>`}`,
  };
}

export const actions = {
  async template() {
    await download(await planImportWorkbook(), "plan_import_template.xlsx");
  },
  async import(ctx, form) {
    const file = form.querySelector("input[type=file]").files[0];
    if (!file) return;
    const f = new FormData(form);
    const parsed = await parseStockFile(file.name, await file.arrayBuffer());
    if (!parsed.rows.length) throw new StockError(parsed.warnings.join(" / ") || "明細が見つかりませんでした");
    const { plans, errors, lines } = plansFromRows(ctx.state, parsed.rows, {
      due: String(f.get("due") || todayJst()), title: String(f.get("title") || "").trim(), filename: file.name,
      location_id: String(f.get("location_id") || ""), source_id: String(f.get("source_id") || ""),
    });
    if (!plans.length) throw new StockError(`取り込める行がありませんでした: ${errors.slice(0, 10).join(" / ")}`);
    await createPlans(plans);
    const error = errors.length ? `取り込まなかった行 ${errors.length}件: ${errors.slice(0, 10).join(" / ")}${errors.length > 10 ? " ほか" : ""}` : null;
    go(ctx.urlWith(), { msg: `納品予定を ${plans.length}件作成しました（明細 ${lines}行）`, error });
  },
  filter(ctx, form) {
    const id = new FormData(form).get("location_id");
    go(id ? `#/plans?location_id=${id}` : "#/plans");
  },
  async setStatus(ctx, el) {
    const plan = ctx.state.plans.get(el.dataset.id);
    if (!plan) return;
    await savePlan({ ...plan, status: el.dataset.status });
    go(ctx.urlWith(), { msg: `「${plan.title || "納品予定"}」を${PLAN_STATUS[el.dataset.status]}にしました` });
  },
};
