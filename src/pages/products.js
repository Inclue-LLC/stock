import { go, searchHash } from "../app.js";
import { mutate } from "../db.js";
import { parseProductFile } from "../domain/files.js";
import {
  StockError, deleteProduct, importProducts, matches, paginate, productTotal, productsByName, saveProduct, sortedProducts, todayJst,
} from "../domain/inventory.js";
import { tryNormalize } from "../domain/jan.js";
import { parseQuantity } from "../domain/tables.js";
import { dropzone, empty, html, icon, n, pager, stockQty } from "../ui.js";
import { backupWorkbook, download, productMasterWorkbook } from "../xlsxWrite.js";

const MAX_UPLOAD = 20 * 1024 * 1024;

export function render(ctx) {
  const q = ctx.q("q");
  const items = sortedProducts(ctx.state).filter((p) => matches(p, q));
  const page = paginate(items, 1, Infinity); // 1ページに全件表示
  const brands = [...new Set([...ctx.state.products.values()].map((p) => p.brand).filter(Boolean))].sort();
  const characters = [...new Set([...ctx.state.products.values()].map((p) => p.character).filter(Boolean))].sort();
  return {
    title: "商品マスタ",
    sub: "商品はJANコードで管理します（JANのない商品は商品名で管理）",
    actions: html`<button class="ghost" data-click="backup">${icon("download")}全データのバックアップ</button>`,
    body: html`
    <div class="grid half">
      <section class="card">
        <div class="card-head"><h2>商品を1件登録</h2></div>
        <form data-action="create" class="card-body form">
          <div class="row">
            <label class="field"><span>JANコード（8桁 / 13桁・ない場合は空欄）</span><input name="jan" value="${ctx.q("jan")}" class="mono" inputmode="numeric" placeholder="4580703202780"></label>
            <label class="field"><span>品番（任意）</span><input name="sku" placeholder="A-001"></label>
          </div>
          <label class="field"><span>商品名</span><input name="name" required></label>
          <div class="row">
            <label class="field"><span>キャラクター名</span><input name="character" list="characters"></label>
            <label class="field"><span>ブランド</span><input name="brand" list="brands"></label>
          </div>
          <div class="row">
            <label class="field"><span>上代（税込）</span><input name="price" inputmode="numeric" placeholder="1650"></label>
            <label class="field"><span>単位</span><input name="unit" value="個"></label>
          </div>
          <label class="field"><span>備考</span><input name="note"></label>
          <datalist id="brands">${brands.map((b) => html`<option value="${b}">`)}</datalist>
          <datalist id="characters">${characters.map((c) => html`<option value="${c}">`)}</datalist>
          <div><button>${icon("plus")}登録する</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>Excel / CSV で一括登録</h2><a href="#" data-click="template">${icon("download")} テンプレート</a></div>
        <form data-action="import" class="card-body form">
          ${dropzone("ファイルを選択、またはドラッグ＆ドロップ", ".xlsx / .csv ・「JANコード」「商品名」の列が必要（キャラクター名・ブランド・上代・品番などは任意）", ".xlsx,.xlsm,.csv")}
          <p class="hint" style="margin:0">同じJANコードの商品があれば、空欄以外の項目を上書きします。</p>
          <div><button>${icon("upload")}取り込む</button></div>
        </form>
      </section>
    </div>
    <section class="card">
      <form class="toolbar" data-action="search" data-search>
        <label class="search grow">${icon("search")}<input type="search" name="q" value="${q}" placeholder="JANコード・品番・商品名・キャラクター名で検索"></label>
        <button class="ghost">検索</button>
      </form>
      ${page.items.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>キャラクター</th><th>商品名</th><th>ブランド</th><th>JANコード</th><th>品番</th><th class="r">上代</th><th class="r">総在庫</th><th></th></tr></thead>
        <tbody>${page.items.map((p) => {
          const total = productTotal(ctx.state, p.id);
          return html`<tr>
            <td>${p.character}</td>
            <td class="name"><a href="#/products/${p.id}">${p.name}</a></td><td>${p.brand}</td>
            <td class="mono">${p.jan || ""}${p.jan ? "" : html`<span class="chip k">JANなし</span>`}</td><td>${p.sku}</td>
            <td class="r">${p.price == null ? "" : n(p.price)}</td>
            <td class="r">${stockQty(total)}</td>
            <td class="r"><button type="button" class="danger sm" data-click="remove" data-id="${p.id}"
              data-confirm="${`「${p.name}」を削除しますか？\n各拠点のこの商品の在庫も削除されます（元に戻せません）。`}">削除</button></td></tr>`;
        })}</tbody></table></div>${pager(page, ctx.urlWith)}`
        : empty(q ? "該当する商品はありません。" : "商品はまだ登録されていません。")}
    </section>`,
  };
}

/** 商品フォームの値を検証して取り出す。 */
export function productFields(form) {
  const f = new FormData(form);
  const s = (k) => String(f.get(k) || "").trim();
  const [jan, err] = s("jan") ? tryNormalize(s("jan")) : [null, null];
  if (err) throw new StockError(err);
  if (!s("name")) throw new StockError("商品名を入力してください");
  return { jan, name: s("name"), sku: s("sku"), brand: s("brand"), character: s("character"), price: s("price") ? parseQuantity(s("price")) : null,
    unit: s("unit") || "個", note: String(f.get("note") || "") };
}

export const actions = {
  search(ctx, form) {
    go(searchHash(ctx, form));
  },
  async create(ctx, form) {
    const v = productFields(form);
    await mutate((W) => {
      if (!v.jan && productsByName(W, v.name, true).length) throw new StockError(`JANなしの商品「${v.name}」はすでに登録されています`);
      saveProduct(W, v);
    });
    go("#/products", { msg: `商品「${v.name}」を登録しました` });
  },
  async import(ctx, form) {
    const file = form.querySelector("input[type=file]").files[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD) throw new StockError("ファイルサイズが大きすぎます（上限20MB）");
    const parsed = await parseProductFile(file.name, await file.arrayBuffer());
    if (!parsed.rows.length) throw new StockError(parsed.warnings.join(" / ") || "商品が見つかりませんでした");
    const result = await mutate((W) => ({ result: importProducts(W, parsed.rows) }));
    const errors = result.errors.length
      ? `エラー ${result.errors.length}件（取り込まれていません）: ${result.errors.slice(0, 10).join(" / ")}`
        + (result.errors.length > 10 ? ` ほか${result.errors.length - 10}件` : "")
      : null;
    go("#/products", { msg: `商品マスタを取り込みました：新規 ${result.created}件、更新 ${result.updated}件`, error: errors });
  },
  async remove(ctx, el) {
    const name = ctx.state.products.get(el.dataset.id)?.name || "";
    await mutate((W) => deleteProduct(W, el.dataset.id));
    go(ctx.urlWith(), { msg: `商品「${name}」を削除しました` });
  },
  async template() {
    await download(await productMasterWorkbook(), "product_master.xlsx");
  },
  async backup(ctx) {
    await download(await backupWorkbook(ctx.state), `stock_backup_${todayJst()}.xlsx`);
  },
};
