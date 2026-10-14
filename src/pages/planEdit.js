import { go } from "../app.js";
import { completePlan, deletePlan, savePlan } from "../db.js";
import { parseStockFile } from "../domain/files.js";
import { StockError, sortedLocations, sortedProducts, todayJst } from "../domain/inventory.js";
import { PLAN_STATUS, dueLabel, emptyPlan, lineFromText, planQuantity, resolveLine } from "../domain/plans.js";
import { empty, html, icon, locationOptions, n } from "../ui.js";

const productText = (p) => `${p.jan ? `${p.jan} ` : ""}${p.name}`;

function lineRow(state, line = { name: "", jan: "", quantity: "" }) {
  const [product, , err] = line.name || line.jan || line.product_id ? resolveLine(state, line) : [null, null, null];
  const text = product ? productText(product) : `${line.jan ? `${line.jan} ` : ""}${line.name || ""}`;
  return html`<tr>
    <td><input name="line_product" list="product-options" value="${text}" placeholder="JANコード または 商品名" class="grow-input"></td>
    <td class="r" style="width:120px"><input name="line_qty" type="number" min="0" value="${line.quantity}" inputmode="numeric" style="text-align:right"></td>
    <td class="hint">${err ? html`<span class="neg">${err}</span>` : product ? "" : line.name || line.jan ? "新規商品として登録" : ""}</td>
    <td class="r" style="width:48px"><button type="button" class="ghost sm" data-remove-line title="この行を削除">×</button></td>
  </tr>`;
}

export function render(ctx) {
  const isNew = ctx.args[0] === "new";
  const plan = isNew ? { ...emptyPlan(), location_id: ctx.q("location_id") } : ctx.state.plans?.get(ctx.args[0]);
  waitingForData = !plan;
  if (!plan) return { title: "納品予定が見つかりません", body: empty("削除されたか、URL が正しくありません。", "#/plans", "納品予定の一覧へ") };
  const locs = sortedLocations(ctx.state);
  const showComplete = !isNew && plan.status !== "done" && plan.status !== "cancelled";
  const highlight = ctx.q("complete") === "1";
  const src = plan.source_id ? ctx.state.locations.get(plan.source_id) : null;
  const dest = ctx.state.locations.get(plan.location_id);
  return {
    title: isNew ? "新しい納品予定" : plan.title || "納品予定",
    sub: isNew ? "納品先・予定日・商品と数量を入力します（明細はあとから追加してもかまいません）"
      : html`<span class="chip k">${PLAN_STATUS[plan.status]}</span>　予定 ${dueLabel(plan)}${plan.applied ? html`　<span class="chip s-applied">在庫反映済</span>` : ""}`,
    actions: html`<a class="btn ghost" href="#/plans">納品予定の一覧へ</a>`,
    body: html`
    ${showComplete ? html`<section class="card ${highlight ? "highlight" : ""}" id="complete">
      <div class="card-head"><h2>完了にする</h2></div>
      <form data-action="complete" class="card-body toolbar">
        <label class="field" style="max-width:200px"><span>実際の納品日</span><input type="date" name="date" value="${todayJst()}"></label>
        <label class="check"><input type="checkbox" name="apply" value="1" ${plan.lines.length ? "checked" : "disabled"}>
          在庫に反映する（${dest ? dest.name : "納品先"} に${n(planQuantity(plan))}点を加算${src ? `、${src.name} から減算` : ""}）</label>
        <button>${icon("check")}完了にする</button>
      </form>
    </section>` : ""}
    <section class="card">
      <form data-action="save" class="card-body form" id="plan-form">
        <label class="field"><span>タイトル</span><input name="title" value="${plan.title}" placeholder="例：GiGO新大久保 11月追加納品" required></label>
        <div class="row">
          <label class="field"><span>納品先</span><select name="location_id" required>${locationOptions(locs, plan.location_id || null, "選択してください")}</select></label>
          <label class="field"><span>出荷元（任意。完了時にここから在庫を減らします）</span><select name="source_id">${locationOptions(locs, plan.source_id || null, "なし（新規入荷など）")}</select></label>
        </div>
        <div class="row">
          <label class="field"><span>予定日</span><input type="date" name="due" value="${plan.due}" required></label>
          <label class="field"><span>状態</span><select name="status">${Object.entries(PLAN_STATUS).map(([k, v]) =>
            html`<option value="${k}" ${plan.status === k ? "selected" : ""}>${v}</option>`)}</select></label>
        </div>
        <label class="field"><span>メモ</span><textarea name="memo" placeholder="担当者・連絡事項など">${plan.memo}</textarea></label>

        <div class="field"><span>明細（商品と数量）　合計 <b data-total>${n(planQuantity(plan))}</b> 点</span>
          <div class="table-wrap lines"><table>
            <thead><tr><th>商品（JANコード または 商品名）</th><th class="r">数量</th><th></th><th></th></tr></thead>
            <tbody data-lines>${(plan.lines.length ? plan.lines : [undefined]).map((l) => lineRow(ctx.state, l))}</tbody>
          </table></div>
          <div class="actions" style="margin-top:8px">
            <button type="button" class="ghost sm" data-add-line>${icon("plus")}行を追加</button>
            <label class="btn ghost sm" style="cursor:pointer">${icon("upload")}Excel / CSV / PDF から明細を読み込む
              <input type="file" data-lines-file accept=".xlsx,.xlsm,.csv,.pdf" hidden></label>
          </div>
          <template data-line-template>${lineRow(ctx.state)}</template>
          <datalist id="product-options">${sortedProducts(ctx.state).map((p) => html`<option value="${productText(p)}">`)}</datalist>
        </div>
        <div class="actions">
          <button class="lg">${icon("check")}${isNew ? "登録する" : "保存する"}</button>
          ${isNew ? "" : html`<button type="button" class="danger" data-click="remove" data-confirm="この納品予定を削除しますか？（在庫は変わりません）">削除</button>`}
        </div>
      </form>
    </section>`,
  };
}

// 入力中に他の人の更新で消えないよう、自動では描き直さない。
// ただし保存直後でまだデータが届いていない（「見つかりません」を表示した）ときは、届いたら描き直す。
let waitingForData = false;
export const live = () => waitingForData;

function updateTotal(root) {
  const total = [...root.querySelectorAll('input[name="line_qty"]')].reduce((a, i) => a + (Number(i.value) || 0), 0);
  const el = root.querySelector("[data-total]");
  if (el) el.textContent = total.toLocaleString("ja-JP");
}

export function mounted(ctx, root) {
  const body = root.querySelector("[data-lines]");
  if (!body) return;
  const template = root.querySelector("[data-line-template]");
  const addRow = (values) => {
    const row = template.content.firstElementChild.cloneNode(true);
    if (values) {
      row.querySelector('[name="line_product"]').value = values.text;
      row.querySelector('[name="line_qty"]').value = values.quantity ?? "";
    }
    body.appendChild(row);
    return row;
  };
  root.querySelector("[data-add-line]").addEventListener("click", () => addRow().querySelector("input").focus());
  body.addEventListener("click", (e) => {
    if (!e.target.closest("[data-remove-line]")) return;
    e.target.closest("tr").remove();
    if (!body.children.length) addRow();
    updateTotal(root);
  });
  body.addEventListener("input", () => updateTotal(root));
  root.querySelector("[data-lines-file]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = await parseStockFile(file.name, await file.arrayBuffer());
      // 空の行を消してから追加
      for (const tr of [...body.children]) if (!tr.querySelector('[name="line_product"]').value) tr.remove();
      for (const r of parsed.rows) addRow({ text: `${r.jan ? `${r.jan} ` : ""}${r.name || ""}`.trim() || r.sku, quantity: r.quantity });
      if (!body.children.length) addRow();
      updateTotal(root);
      alert(`${parsed.rows.length}行を読み込みました。内容を確認して「保存する」を押してください。`);
    } catch (err) {
      alert(`読み込めませんでした: ${err.message}`);
    }
    e.target.value = "";
  });
  if (ctx.q("complete") === "1") root.querySelector("#complete")?.scrollIntoView({ block: "start" });
}

function readForm(ctx, form) {
  const f = new FormData(form);
  const s = (k) => String(f.get(k) || "").trim();
  const texts = f.getAll("line_product");
  const qtys = f.getAll("line_qty");
  const lines = [];
  texts.forEach((t, i) => {
    if (!String(t).trim()) return;
    const q = Number(qtys[i]);
    if (!Number.isInteger(q) || q < 0) throw new StockError(`明細${i + 1}行目: 数量を0以上の整数で入力してください`);
    lines.push(lineFromText(ctx.state, t, q));
  });
  if (!s("location_id")) throw new StockError("納品先を選択してください");
  if (s("source_id") && s("source_id") === s("location_id")) throw new StockError("出荷元と納品先が同じです");
  return { title: s("title"), location_id: s("location_id"), source_id: s("source_id"), due: s("due"), status: s("status") || "todo",
    memo: String(f.get("memo") || ""), lines };
}

export const actions = {
  async save(ctx, form) {
    const isNew = ctx.args[0] === "new";
    const base = isNew ? emptyPlan() : ctx.state.plans.get(ctx.args[0]);
    const plan = { ...base, ...readForm(ctx, form) };
    const id = await savePlan(plan);
    go(`#/plans/${id}`, { msg: isNew ? "納品予定を登録しました" : "保存しました" });
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

