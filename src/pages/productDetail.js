import { go } from "../app.js";
import { listHistory, mutate } from "../db.js";
import { KINDS, SOURCES, StockError, deleteProduct, saveProduct, sortedLocations } from "../domain/inventory.js";
import { badge, dateTime, delta, empty, html, n } from "../ui.js";
import { productFields } from "./products.js";

export const live = false; // 履歴を読む画面なので、データ変化のたびには描き直さない

export async function render(ctx) {
  const product = ctx.state.products.get(ctx.args[0]);
  if (!product) return { title: "商品が見つかりません", body: empty("この商品は削除されたか、URL が正しくありません。", "#/products", "商品マスタへ") };
  const stocks = sortedLocations(ctx.state)
    .map((l) => ({ location: l, s: ctx.state.stocks.get(l.id)?.get(product.id) }))
    .filter((x) => x.s);
  const total = stocks.reduce((a, x) => a + x.s.q, 0);
  const { items } = await listHistory({ productId: product.id, maxDocs: 50 });
  const movements = items
    .map((m) => ({ ...m, location: ctx.state.locations.get(m.l) }))
    .filter((m) => m.location)
    .sort((a, b) => (b.dt || "").localeCompare(a.dt || "") || b.order[0] - a.order[0])
    .slice(0, 100);
  return {
    title: product.name,
    sub: html`${product.character ? html`${product.character}　` : ""}${product.brand ? html`${product.brand}　` : ""}<span class="mono">${product.jan ? `JAN ${product.jan}` : "JANなし"}</span>${product.sku ? `　品番 ${product.sku}` : ""}`,
    body: html`
    <div class="grid two">
      <section class="card">
        <div class="card-head"><h2>拠点別の在庫</h2><span class="muted">合計 <b style="color:var(--text);font-size:16px">${n(total)}</b> ${product.unit}</span></div>
        ${stocks.length ? html`<ul class="loc-list" style="margin-top:8px">${stocks.map(({ location, s }) => html`
          <li><span><a class="lname" href="#/locations/${location.id}">${location.name}</a> ${badge(location)}</span><b class="num">${n(s.q)}</b></li>`)}</ul>`
          : empty("この商品の在庫はありません。")}
      </section>
      <section class="card">
        <div class="card-head"><h2>商品情報</h2></div>
        <form data-action="update" class="card-body form">
          <div class="row">
            <label class="field"><span>JANコード</span><input name="jan" value="${product.jan || ""}" class="mono" placeholder="なし"></label>
            <label class="field"><span>品番</span><input name="sku" value="${product.sku}"></label>
          </div>
          <label class="field"><span>商品名</span><input name="name" value="${product.name}" required></label>
          <div class="row">
            <label class="field"><span>キャラクター名</span><input name="character" value="${product.character || ""}"></label>
            <label class="field"><span>ブランド</span><input name="brand" value="${product.brand}"></label>
          </div>
          <div class="row">
            <label class="field"><span>上代（税込）</span><input name="price" value="${product.price ?? ""}" inputmode="numeric"></label>
            <label class="field"><span>単位</span><input name="unit" value="${product.unit}"></label>
          </div>
          <label class="field"><span>備考</span><textarea name="note">${product.note}</textarea></label>
          <div class="actions">
            <button>保存</button>
            <button type="button" class="danger" data-click="remove" data-confirm="この商品を削除しますか？">削除</button>
          </div>
        </form>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h2>入出庫履歴</h2><span class="muted">新しい順</span></div>
      ${movements.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>区分</th><th>拠点</th><th class="r">増減</th><th class="r">変更後</th><th>入力元</th><th>備考</th></tr></thead>
        <tbody>${movements.map((m) => html`<tr>
          <td class="nowrap muted">${m.dt || dateTime(m.created_at).slice(0, 10)}</td>
          <td><span class="chip k">${KINDS[m.k]}</span></td><td>${m.location.name}</td>
          <td class="r">${delta(m.d)}</td><td class="r">${n(m.a)}</td>
          <td>${m.batch_id ? html`<a href="#/imports/${m.batch_id}">${SOURCES[m.source]}</a>` : SOURCES[m.source]}</td>
          <td class="muted">${m.n}</td></tr>`)}</tbody></table></div>` : empty("履歴はありません。")}
    </section>`,
  };
}


export const actions = {
  async update(ctx, form) {
    const v = productFields(form);
    const id = ctx.args[0];
    await mutate((W) => {
      const cur = W.products.get(id);
      if (!cur) throw new StockError("商品が見つかりません");
      saveProduct(W, { ...cur, ...v });
    });
    go(`#/products/${id}`, { msg: "商品を更新しました" });
  },
  async remove(ctx) {
    await mutate((W) => deleteProduct(W, ctx.args[0]));
    go("#/products", { msg: "商品を削除しました" });
  },
};
