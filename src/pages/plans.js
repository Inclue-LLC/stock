import { go } from "../app.js";
import { savePlan } from "../db.js";
import { sortedLocations } from "../domain/inventory.js";
import { PLAN_STATUS, dueClass, dueLabel, planQuantity, sortPlans } from "../domain/plans.js";
import { empty, html, icon, locationOptions, n } from "../ui.js";

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
  const overdue = all.filter((p) => dueClass(p) === "overdue").length;
  return {
    title: "納品予定",
    sub: "これから納品する予定を、予定 → 準備中 → 完了 の順に管理します。完了時に在庫へ反映できます",
    actions: html`<a class="btn" href="#/plans/new${locationId ? `?location_id=${locationId}` : ""}">${icon("plus")}新しい納品予定</a>`,
    body: html`
    <form class="toolbar" data-action="filter" data-search style="margin-bottom:16px">
      <select name="location_id" data-autosubmit>${locationOptions(sortedLocations(ctx.state), locationId || null, "すべての拠点")}</select>
      ${overdue ? html`<span class="chip out">予定日を過ぎた予定 ${overdue}件</span>` : ""}
      <span class="legend"><span class="dot overdue"></span>予定日を過ぎた　<span class="dot soon"></span>7日以内</span>
    </form>
    ${all.length ? html`<div class="board">${cols.map(([status, label, items]) => html`
      <section class="board-col col-${status}">
        <h2>${label} <span class="muted">${items.length}</span></h2>
        ${items.length ? items.map((p) => card(ctx, p)) : html`<div class="board-empty">なし</div>`}
      </section>`)}</div>`
      : html`<section class="card">${empty("納品予定はまだありません。", "#/plans/new", "新しい納品予定を作る")}</section>`}`,
  };
}

export const actions = {
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
