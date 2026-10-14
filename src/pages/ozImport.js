import { go } from "../app.js";
import { mutate } from "../db.js";
import { StockError } from "../domain/inventory.js";
import { readXlsx } from "../domain/xlsxRead.js";
import { runOzImport } from "../domain/ozImport.js";
import { dropzone, html, icon } from "../ui.js";

let last = null; // 直前の結果（画面表示用。URL の r= と対応させ、別の画面に移ると表示しない）

class DryRun extends Error {}

export function render(ctx) {
  const result = last && ctx.q("r") === last.token ? last : null;
  return {
    title: "初期データの取り込み",
    sub: "「OZ 納品数集計」Excel から、キャナルシティ博多店・GiGO新大久保の納品・販売・在庫をまとめて取り込みます（最初の1回だけ）",
    body: html`
    ${result ? html`<section class="card">
      <div class="card-head"><h2>${result.saved ? "取り込みました" : "確認結果（まだ保存していません）"}</h2><span class="muted">${result.filename}</span></div>
      <div class="card-body">
        <p>商品: 新規 <b>${result.created}</b>件 / 既存 <b>${result.updated}</b>件</p>
        <ul class="steps">${result.stores.map((s) => html`<li>${s}</li>`)}</ul>
        ${result.warnings.length ? html`<details class="more" style="margin-top:12px" open>
          <summary>注意 ${result.warnings.length}件（JANコードの重複・誤りを自動で補正しました）</summary>
          <ul class="steps" style="margin-top:8px">${result.warnings.map((w) => html`<li>${w}</li>`)}</ul></details>` : ""}
        ${result.saved ? html`<p style="margin-top:16px"><a class="btn" href="#/locations">拠点の画面を開く</a></p>` : ""}
      </div></section>` : ""}
    ${!result || !result.saved ? html`<section class="card">
      <form data-action="run" class="card-body form">
        ${dropzone("OZ 納品数集計の Excel を選択、またはドラッグ＆ドロップ", "シート「OZ納品数_商品別」「GiGO新大久保」「キャナル販売データ」「キャナル販売在庫」を使います", ".xlsx")}
        <div class="actions">
          <button name="mode" value="check" class="ghost lg">確認する（保存しない）</button>
          <button name="mode" value="save" class="lg" data-confirm="取り込みますか？（1回だけ実行してください）">${icon("upload")}取り込む</button>
        </div>
        <p class="hint" style="margin:0">「2512 OZ広島」は取り込みません。すでに記録がある店舗がある場合は、二重取込を防ぐため中止します。</p>
      </form></section>` : ""}`,
  };
}

export const actions = {
  async run(ctx, form, event) {
    const file = form.querySelector("input[type=file]").files[0];
    if (!file) return;
    const save = event.submitter?.value === "save";
    const sheets = new Map(readXlsx(await file.arrayBuffer()));
    let result;
    try {
      await mutate((W) => {
        try {
          result = runOzImport(W, sheets);
        } catch (e) {
          throw new StockError(e.message);
        }
        if (!save) throw new DryRun(); // 保存せずに結果だけ表示
        return { history: { filename: file.name, source: "EXCEL" } };
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    last = { ...result, saved: save, filename: file.name, token: String(Date.now()) };
    go(`#/imports/oz?r=${last.token}`);
  },
};
