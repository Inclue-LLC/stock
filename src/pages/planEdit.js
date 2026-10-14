import { go } from "../app.js";
import { completePlan, deletePlan, savePlan } from "../db.js";
import { StockError, sortedLocations, todayJst } from "../domain/inventory.js";
import { PLAN_STATUS, planQuantity, resolveLine } from "../domain/plans.js";
import { empty, html, icon, locationOptions, n } from "../ui.js";

// 入力中に他の人の更新で消えないよう、自動では描き直さない。
// ただし保存直後でまだデータが届いていない（「見つかりません」を表示した）ときは、届いたら描き直す。
let waitingForData = false;
export const live = () => waitingForData;

export function render(ctx) {
  const plan = ctx.state.plans?.get(ctx.args[0]);
  waitingForData = !plan;
  if (!plan) return { title: "納品予定が見つかりません", body: empty("削除されたか、URL が正しくありません。", "#/plans", "納品予定の一覧へ") };
  const locs = sortedLocations(ctx.state);
  const showComplete = plan.status !== "done" && plan.status !== "cancelled";
  const src = plan.source_id ? ctx.state.locations.get(plan.source_id) : null;
  const dest = ctx.state.locations.get(plan.location_id);
  return {
    title: plan.title || "納品予定",
    sub: html`<span class="chip k">${PLAN_STATUS[plan.status]}</span>${plan.applied ? html`　<span class="chip s-applied">在庫反映済</span>` : ""}`,
    actions: html`<a class="btn ghost" href="#/plans">納品予定の一覧へ</a>`,
    body: html`
    ${showComplete ? html`<section class="card ${ctx.q("complete") === "1" ? "highlight" : ""}" id="complete">
      <div class="card-head"><h2>完了にする</h2></div>
      <form data-action="complete" class="card-body toolbar">
        <label class="field" style="max-width:200px"><span>実際の納品日</span><input type="date" name="date" value="${todayJst()}"></label>
        <label class="check"><input type="checkbox" name="apply" value="1" ${plan.lines.length ? "checked" : "disabled"}>
          在庫に反映する（${dest ? dest.name : "納品先"} に${n(planQuantity(plan))}点を加算${src ? `、${src.name} から減算` : ""}）</label>
        <button>${icon("check")}完了にする</button>
      </form>
    </section>` : ""}

    <section class="card">
      <div class="card-head"><h2>明細</h2><span class="muted">${plan.lines.length}件・合計 ${n(planQuantity(plan))}点</span></div>
      ${plan.lines.length ? html`<div class="table-wrap" style="margin-top:12px"><table>
        <thead><tr><th>キャラクター</th><th>商品</th><th>JANコード</th><th class="r">数量</th><th></th></tr></thead>
        <tbody>${plan.lines.map((l) => {
          const [product, , err] = resolveLine(ctx.state, l);
          return html`<tr>
            <td>${product?.character || l.character || ""}</td>
            <td class="name">${product ? html`<a href="#/products/${product.id}">${product.name}</a>` : l.name}</td>
            <td class="mono">${(product ? product.jan : l.jan) || "JANなし"}</td>
            <td class="r"><b>${n(l.quantity)}</b></td>
            <td class="hint">${err ? html`<span class="neg">${err}</span>` : product ? "" : "完了時に新規商品として登録"}</td></tr>`;
        })}</tbody></table></div>` : empty("明細はありません。")}
    </section>

    <section class="card">
      <div class="card-head"><h2>予定の内容</h2></div>
      <form data-action="save" class="card-body form" id="plan-form">
        <label class="field"><span>タイトル</span><input name="title" value="${plan.title}" required></label>
        <div class="row">
          <label class="field"><span>納品先</span><select name="location_id" required>${locationOptions(locs, plan.location_id || null, "選択してください")}</select></label>
          <label class="field"><span>出荷元（任意。完了時にここから在庫を減らします）</span><select name="source_id">${locationOptions(locs, plan.source_id || null, "なし（新規入荷など）")}</select></label>
        </div>
        <label class="field" style="max-width:200px"><span>状態</span><select name="status">${Object.entries(PLAN_STATUS).map(([k, v]) =>
          html`<option value="${k}" ${plan.status === k ? "selected" : ""}>${v}</option>`)}</select></label>
        <label class="field"><span>メモ</span><textarea name="memo" placeholder="担当者・連絡事項など">${plan.memo}</textarea></label>
        <div class="actions">
          <button>${icon("check")}保存する</button>
          <button type="button" class="danger" data-click="remove" data-confirm="この納品予定を削除しますか？（在庫は変わりません）">削除</button>
        </div>
      </form>
    </section>`,
  };
}

export function mounted(ctx, root) {
  if (ctx.q("complete") === "1") root.querySelector("#complete")?.scrollIntoView({ block: "start" });
}

function readForm(form) {
  const f = new FormData(form);
  const s = (k) => String(f.get(k) || "").trim();
  if (!s("location_id")) throw new StockError("納品先を選択してください");
  if (s("source_id") && s("source_id") === s("location_id")) throw new StockError("出荷元と納品先が同じです");
  return { title: s("title"), location_id: s("location_id"), source_id: s("source_id"), status: s("status") || "todo",
    memo: String(f.get("memo") || "") };
}

export const actions = {
  async save(ctx, form) {
    const base = ctx.state.plans.get(ctx.args[0]);
    if (!base) throw new StockError("納品予定が見つかりません");
    const id = await savePlan({ ...base, ...readForm(form) });
    go(`#/plans/${id}`, { msg: "保存しました" });
  },
  async complete(ctx, form) {
    const id = ctx.args[0];
    const f = new FormData(form);
    const apply = f.get("apply") === "1";
    const r = await completePlan(id, String(f.get("date") || todayJst()), apply);
    go("#/plans", { msg: apply ? `完了にして、在庫に ${r.quantity.toLocaleString("ja-JP")}点を反映しました` : "完了にしました（在庫は変わりません）" });
  },
  async remove(ctx) {
    await deletePlan(ctx.args[0]);
    go("#/plans", { msg: "納品予定を削除しました" });
  },
};
