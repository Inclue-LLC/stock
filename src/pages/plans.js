import { go } from "../app.js";
import { createPlans } from "../db.js";
import { parseStockFile } from "../domain/files.js";
import { StockError, sortedLocations } from "../domain/inventory.js";
import { planQuantity, planTitle, plansFromRows, renameLines, sortPlans } from "../domain/plans.js";
import { dropzone, empty, html, icon, locationOptions, n } from "../ui.js";
import { download, planExportWorkbook, planImportWorkbook } from "../xlsxWrite.js";

const COLUMNS = [["todo", "予定"], ["done", "完了"]];
const DONE_LIMIT = 30; // 完了の列は新しい順にこの件数まで

// 登録済みと商品名が違う行があったときの、作成前の確認待ちの取込（{ plans, errors, lines, diffs, filename }）
let pending = null;

function confirmCard(p) {
  return html`<section class="card highlight">
    <div class="card-head"><h2>商品名の確認</h2><span class="muted">${p.filename}</span></div>
    <form data-action="confirmImport" class="card-body form">
      <div class="alert warn" style="margin:0">${icon("alert")}<span>登録済みの商品と<b>商品名が違う商品が ${p.diffs.length}件</b>あります。
        商品ごとに、登録済みの商品名のままにするか、ファイルの商品名に変えるかを選んでから作成してください。
        <span class="setall"><button type="button" class="ghost sm" data-setall="keep">すべて登録済みのまま</button>
        <button type="button" class="ghost sm" data-setall="0">すべてファイルの商品名にする</button></span></span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>JANコード</th><th>商品名</th></tr></thead>
        <tbody>${p.diffs.map(({ product, names }) => html`<tr class="row-diff">
          <td class="mono">${product.jan || "JANなし"}</td>
          <td class="name"><div class="name-choice">
            <label><input type="radio" name="rn_${product.id}" value="keep" checked><span><small>登録済み</small>${product.name}</span></label>
            ${names.map((name, i) => html`<label><input type="radio" name="rn_${product.id}" value="${i}"><span><small>ファイル</small>${name}</span></label>`)}
          </div></td></tr>`)}</tbody>
      </table></div>
      <p class="hint" style="margin:0">作成する納品予定: ${p.plans.length}件（明細 ${p.lines}行）${p.errors.length ? `・取り込まない行 ${p.errors.length}件` : ""}</p>
      <div class="actions"><button>${icon("check")}この内容で納品予定を作成</button>
        <button type="button" class="ghost" data-click="cancelImport">やめる</button></div>
    </form>
  </section>`;
}

function card(ctx, p) {
  const src = p.source_id ? ctx.state.locations.get(p.source_id) : null;
  const next = p.status === "todo" ? html`<a class="btn sm" href="#/plans/${p.id}?complete=1">完了にする ›</a>` : "";
  return html`<div class="plan-card">
    <a class="plan-title" href="#/plans/${p.id}">${planTitle(ctx.state, p)}</a>
    ${src ? html`<div class="plan-meta muted">出荷元: ${src.name}</div>` : ""}
    ${p.status === "done" && p.done_date ? html`<div class="plan-meta"><span class="due">完了 ${p.done_date.slice(5).replace("-", "/")}</span></div>` : ""}
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
  return {
    title: "納品予定",
    actions: html`<button class="ghost" data-click="export" title="「予定」の納品予定の商品一覧を、納品先付きで Excel に出力します">${icon("download")}Excel出力（予定の商品一覧）</button>`,
    sub: "これから納品する予定を「予定」→「完了」で管理します。完了時に在庫へ反映できます",
    body: html`
    ${pending ? confirmCard(pending) : html`<section class="card">
      <div class="card-head"><h2>Excel から納品予定を作成</h2><a href="#" data-click="template">${icon("download")} テンプレート</a></div>
      <form data-action="import" class="card-body form">
        <div class="grid half" style="gap:16px">
          ${dropzone("ファイルを選択、またはドラッグ＆ドロップ", "列: JANコード・キャラクター名・商品名・数量・拠点（.xlsx / .csv）", ".xlsx,.xlsm,.csv")}
          <div class="form">
            <label class="field"><span>納品先（「拠点」列が空の行に使います）</span>
              <select name="location_id">${locationOptions(locs, locationId || null, "ファイル内の「拠点」列を使う")}</select></label>
            <label class="field"><span>出荷元（任意。完了時にここから在庫を減らします）</span>
              <select name="source_id">${locationOptions(locs, null, "なし（新規入荷など）")}</select></label>
          </div>
        </div>
        <p class="hint" style="margin:0">拠点（納品先）ごとに1件の納品予定になります。</p>
        <div><button>${icon("upload")}読み込んで納品予定を作成</button></div>
      </form>
    </section>`}
    <form class="toolbar" data-action="filter" data-search style="margin-bottom:16px">
      <select name="location_id" data-autosubmit>${locationOptions(locs, locationId || null, "すべての拠点")}</select>
    </form>
    ${all.length ? html`<div class="board">${cols.map(([status, label, items]) => html`
      <section class="board-col col-${status}">
        <h2>${label} <span class="muted">${items.length}</span></h2>
        ${items.length ? items.map((p) => card(ctx, p)) : html`<div class="board-empty">なし</div>`}
      </section>`)}</div>`
      : html`<section class="card">${empty("納品予定はまだありません。上のフォームから Excel を取り込んで作成してください。")}</section>`}`,
  };
}

export function mounted(ctx, root) {
  for (const b of root.querySelectorAll("[data-setall]")) {
    b.addEventListener("click", () => {
      for (const r of root.querySelectorAll(`.name-choice input[value="${b.dataset.setall}"]`)) r.checked = true;
    });
  }
}

async function create(ctx, { plans, errors, lines }, renames = []) {
  await createPlans(renameLines(plans, renames), renames);
  pending = null;
  const error = errors.length ? `取り込まなかった行 ${errors.length}件: ${errors.slice(0, 10).join(" / ")}${errors.length > 10 ? " ほか" : ""}` : null;
  const renamed = renames.length ? `。商品名を ${renames.length}件変更しました` : "";
  go(ctx.urlWith(), { msg: `納品予定を ${plans.length}件作成しました（明細 ${lines}行）${renamed}`, error });
}

export const actions = {
  async export(ctx) {
    const locationId = ctx.q("location_id");
    const plans = sortPlans([...(ctx.state.plans?.values() || [])].filter((p) => p.status === "todo"
      && (!locationId || p.location_id === locationId || p.source_id === locationId)));
    if (!plans.length) throw new StockError("「予定」の納品予定がありません");
    await download(await planExportWorkbook(ctx.state, plans), "delivery_plans.xlsx");
  },
  async confirmImport(ctx, form) {
    if (!pending) return;
    const f = new FormData(form);
    const renames = [];
    for (const { product, names } of pending.diffs) {
      const v = f.get(`rn_${product.id}`);
      if (v !== null && v !== "keep") renames.push({ productId: product.id, name: names[Number(v)] });
    }
    await create(ctx, pending, renames);
  },
  cancelImport(ctx) {
    pending = null;
    go(ctx.urlWith(), { msg: "取込をやめました（納品予定は作成していません）" });
  },
  async template() {
    await download(await planImportWorkbook(), "plan_import_template.xlsx");
  },
  async import(ctx, form) {
    const file = form.querySelector("input[type=file]").files[0];
    if (!file) return;
    const f = new FormData(form);
    const parsed = await parseStockFile(file.name, await file.arrayBuffer());
    if (!parsed.rows.length) throw new StockError(parsed.warnings.join(" / ") || "明細が見つかりませんでした");
    const result = plansFromRows(ctx.state, parsed.rows, {
      location_id: String(f.get("location_id") || ""), source_id: String(f.get("source_id") || ""),
    });
    if (!result.plans.length) throw new StockError(`取り込める行がありませんでした: ${result.errors.slice(0, 10).join(" / ")}`);
    if (result.diffs.length) {
      // 登録済みと商品名が違う商品がある → 選んでもらってから作成する
      pending = { ...result, filename: file.name };
      go(ctx.urlWith(), {});
      return;
    }
    await create(ctx, result);
  },
  filter(ctx, form) {
    const id = new FormData(form).get("location_id");
    go(id ? `#/plans?location_id=${id}` : "#/plans");
  },
};
