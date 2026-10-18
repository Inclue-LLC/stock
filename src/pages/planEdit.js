import { go } from "../app.js";
import { download, planExportWorkbook } from "../xlsxWrite.js";
import { completePlan, deletePlan, savePlan } from "../db.js";
import { StockError, sortedLocations, todayJst } from "../domain/inventory.js";
import { PLAN_STATUS, planQuantity, planTitle, resolveLine } from "../domain/plans.js";
import { empty, html, icon, locationOptions, n, yen } from "../ui.js";

// データが変わったら描き直す（入力中のフォームがあるときは app.js の formDirty で描き直さない）
export const live = true;

export function render(ctx) {
  const plan = ctx.state.plans?.get(ctx.args[0]);
  if (!plan) return { title: "納品予定が見つかりません", body: empty("削除されたか、URL が正しくありません。", "#/plans", "納品予定の一覧へ") };
  const locs = sortedLocations(ctx.state);
  const showComplete = plan.status !== "done";
  const editable = !plan.applied; // 在庫に反映済みの予定は数量を変えられない
  const src = plan.source_id ? ctx.state.locations.get(plan.source_id) : null;
  const dest = ctx.state.locations.get(plan.location_id);
  return {
    title: planTitle(ctx.state, plan),
    sub: html`<span class="chip k">${PLAN_STATUS[plan.status]}</span>${plan.applied ? html`　<span class="chip s-applied">在庫反映済</span>` : ""}`,
    actions: html`<button class="ghost" data-click="export">${icon("download")}Excel出力</button>
      <a class="btn ghost" href="#/plans">納品予定の一覧へ</a>`,
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
      ${plan.lines.length ? html`<form data-action="saveLines">
      ${editable ? html`<div class="bulkbar"><span class="hint">数量を入力して保存できます（0 にした行は明細から削除）</span>
        <span class="qty-save" data-lines-save hidden><span class="changed-count" data-lines-count></span>
          <button class="sm">${icon("check")}数量を保存</button>
          <button type="button" class="ghost sm" data-lines-reset>元に戻す</button></span></div>` : ""}
      <div class="table-wrap"><table>
        <thead><tr><th>キャラクター</th><th>商品</th><th>JANコード</th><th class="r">上代（税込）</th><th class="r">数量</th><th></th></tr></thead>
        <tbody>${plan.lines.map((l, i) => {
          const [product, , err] = resolveLine(ctx.state, l);
          return html`<tr>
            <td>${product?.character || l.character || ""}</td>
            <td class="name">${product ? html`<a href="#/products/${product.id}">${product.name}</a>` : l.name}</td>
            <td class="mono">${(product ? product.jan : l.jan) || "JANなし"}</td>
            <td class="r nowrap">${yen(product?.price ?? l.price ?? null)}</td>
            <td class="r">${editable ? html`<input type="number" class="line-qty" name="q_${i}" min="0" step="1" inputmode="numeric"
              value="${l.quantity}" data-orig="${l.quantity}" aria-label="${l.name}の数量">` : html`<b>${n(l.quantity)}</b>`}</td>
            <td class="hint">${err ? html`<span class="neg">${err}</span>` : product ? "" : "完了時に新規商品として登録"}</td></tr>`;
        })}</tbody></table></div></form>` : empty("明細はありません。")}
    </section>

    <section class="card">
      <div class="card-head"><h2>予定の内容</h2></div>
      <form data-action="save" class="card-body form" id="plan-form">
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
  wireLines(root);
  if (ctx.q("complete") === "1") root.querySelector("#complete")?.scrollIntoView({ block: "start" });
}

function readForm(form) {
  const f = new FormData(form);
  const s = (k) => String(f.get(k) || "").trim();
  if (!s("location_id")) throw new StockError("納品先を選択してください");
  if (s("source_id") && s("source_id") === s("location_id")) throw new StockError("出荷元と納品先が同じです");
  return { location_id: s("location_id"), source_id: s("source_id"), status: s("status") || "todo",
    memo: String(f.get("memo") || "") };
}

/** 明細の数量: 変更件数の表示・元に戻す・Enter で保存 */
function wireLines(root) {
  const form = root.querySelector('form[data-action="saveLines"]');
  const bar = form?.querySelector("[data-lines-save]");
  if (!bar) return;
  const inputs = () => [...form.querySelectorAll(".line-qty")];
  const update = () => {
    const count = inputs().filter((i) => i.value !== i.dataset.orig).length;
    for (const i of inputs()) i.classList.toggle("changed", i.value !== i.dataset.orig);
    bar.hidden = count === 0;
    bar.querySelector("[data-lines-count]").textContent = `${count}件の数量を変更中`;
  };
  form.addEventListener("input", update);
  form.addEventListener("focusin", (e) => e.target.matches(".line-qty") && e.target.select());
  bar.querySelector("[data-lines-reset]").addEventListener("click", () => {
    for (const i of inputs()) i.value = i.dataset.orig;
    update();
  });
}

export const actions = {
  async saveLines(ctx, form) {
    const plan = ctx.state.plans.get(ctx.args[0]);
    if (!plan) throw new StockError("納品予定が見つかりません");
    if (plan.applied) throw new StockError("在庫に反映済みの納品予定は数量を変更できません");
    const f = new FormData(form);
    const lines = [];
    plan.lines.forEach((l, i) => {
      const v = f.get(`q_${i}`);
      const q = v === null ? l.quantity : Number(v);
      if (v === "" || !Number.isInteger(q) || q < 0) throw new StockError(`「${l.name}」の数量は 0 以上の整数で入力してください`);
      if (q > 0) lines.push({ ...l, quantity: q });
    });
    if (!lines.length) throw new StockError("すべての行を 0 にはできません。納品予定ごと削除してください");
    const removed = plan.lines.length - lines.length;
    await savePlan({ ...plan, lines });
    go(location.hash, { msg: `数量を保存しました${removed ? `（${removed}行を明細から削除）` : ""}` });
  },
  async export(ctx) {
    const plan = ctx.state.plans.get(ctx.args[0]);
    if (!plan) throw new StockError("納品予定が見つかりません");
    await download(await planExportWorkbook(ctx.state, [plan]), "delivery_plan.xlsx");
  },
  async save(ctx, form) {
    const base = ctx.state.plans.get(ctx.args[0]);
    if (!base) throw new StockError("納品予定が見つかりません");
    const data = readForm(form);
    const id = await savePlan({ ...base, ...data, title: ctx.state.locations.get(data.location_id)?.name || base.title });
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
