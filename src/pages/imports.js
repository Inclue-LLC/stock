import { go } from "../app.js";
import { createImport, listImports } from "../db.js";
import { parseStockFile } from "../domain/files.js";
import { IMPORT_KIND_LABELS, KINDS, SOURCES, StockError, sortedLocations, todayJst } from "../domain/inventory.js";
import { dateTime, dropzone, empty, html, icon, locationOptions } from "../ui.js";
import { download, stockImportWorkbook } from "../xlsxWrite.js";

export const live = false;
const MAX_UPLOAD = 20 * 1024 * 1024;
const STATUS = { pending: "未反映", applied: "反映済", cancelled: "取消" };

export async function render(ctx) {
  const batches = await listImports();
  const locs = sortedLocations(ctx.state);
  const kind = ctx.q("kind") || "SET";
  return {
    title: "在庫の更新",
    sub: "倉庫・委託店舗の在庫を、Excel・CSV・PDF から更新します（確認画面のあと反映）",
    body: html`
    <div class="grid two">
      <section class="card">
        <form data-action="upload" class="card-body form">
          ${dropzone("ファイルを選択、またはドラッグ＆ドロップ", ".xlsx / .csv / .pdf（20MBまで）", ".xlsx,.xlsm,.csv,.pdf")}
          <label class="field"><span>拠点</span>
            <select name="location_id">${locationOptions(locs, ctx.q("location_id") || null, "ファイル内の「拠点」列を使う")}</select></label>
          <div class="field"><span>反映のしかた</span>
            <div class="segmented" id="kinds">${Object.entries(IMPORT_KIND_LABELS).map(([k, label]) => html`
              <label><input type="radio" name="kind" value="${k}" ${kind === k ? "checked" : ""}><span>${label}</span></label>`)}</div>
          </div>
          <label class="field" style="max-width:220px"><span>日付（納品日・報告日など）</span><input type="date" name="on" value="${todayJst()}"></label>
          <label class="check" id="zero" ${kind === "SET" ? "" : "hidden"}><input type="checkbox" name="zero_missing" value="1"> ファイルにない商品の在庫を0にする（拠点の全在庫リストを取り込むとき）</label>
          <div><button class="lg">読み込んで確認する${icon("arrow")}</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>ファイルの形式</h2><a href="#" data-click="template">${icon("download")} テンプレート</a></div>
        <div class="card-body"><ul class="steps">
          <li><b>JANコード</b>（または品番・商品名）と<b>数量</b>の列を自動で探します。見出しが1行目でなくても大丈夫です。</li>
          <li>拠点・ブランド・上代・単位・備考の列は任意です。未登録のJANは、商品名があれば自動で商品登録されます。</li>
          <li>列名は日本語・中国語・英語に対応（JAN／バーコード／条码、数量／在庫数／残数／库存 など）。</li>
          <li>「合計」「小計」の行は無視します。スキャン画像のPDFは読み取れません。</li>
        </ul></div>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h2>取込履歴</h2><a href="#/movements">${icon("history")} 入出庫履歴</a></div>
      ${batches.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>日時</th><th>ファイル</th><th>区分</th><th>拠点</th><th class="r">行数</th><th>状態</th></tr></thead>
        <tbody>${batches.map((b) => html`<tr>
          <td class="nowrap muted">${dateTime(b.created_at)}</td>
          <td class="name"><a href="#/imports/${b.id}">${b.filename}</a><span class="sub">${SOURCES[b.source]}</span></td>
          <td><span class="chip k">${KINDS[b.kind]}</span></td>
          <td>${ctx.state.locations.get(b.location_id)?.name || "ファイル内指定"}</td>
          <td class="r">${b.row_count}</td>
          <td><span class="chip s-${b.status}">${STATUS[b.status]}</span></td></tr>`)}</tbody></table></div>`
        : empty("取込履歴はまだありません。")}
    </section>
    <p class="hint"><a href="#/movements">入出庫履歴を見る</a>　／　<a href="#/imports/oz">初期データの取り込み（OZ 納品数集計 Excel）</a></p>`,
  };
}

export function mounted(ctx, root) {
  const kinds = root.querySelector("#kinds");
  const zero = root.querySelector("#zero");
  kinds?.addEventListener("change", () => {
    zero.hidden = kinds.querySelector("input:checked").value !== "SET";
  });
}

export const actions = {
  async upload(ctx, form) {
    const f = new FormData(form);
    const file = form.querySelector("input[type=file]").files[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD) throw new StockError("ファイルサイズが大きすぎます（上限20MB）");
    let parsed;
    try {
      parsed = await parseStockFile(file.name, await file.arrayBuffer());
    } catch (e) {
      throw new StockError(e.message.startsWith("対応形式") ? e.message : "ファイルを読み込めませんでした。形式を確認してください");
    }
    const kind = String(f.get("kind"));
    const id = await createImport({
      filename: file.name, source: parsed.source, kind, location_id: f.get("location_id") || null,
      zero_missing: kind === "SET" && f.get("zero_missing") === "1", date: String(f.get("on") || todayJst()),
      rows: parsed.rows, warnings: parsed.warnings,
    });
    go(`#/imports/${id}`);
  },
  async template() {
    await download(await stockImportWorkbook(), "stock_import_template.xlsx");
  },
};
