import { go } from "../app.js";
import { mutate } from "../db.js";
import { REGIONS, TYPES, deleteLocation, locationTotal, saveLocation, sortedLocations } from "../domain/inventory.js";
import { badge, dateTime, empty, html, icon, n } from "../ui.js";

const regionSelect = (name, value, form) => html`<select name="${name}" ${form ? html`form="${form}"` : ""}>
  ${Object.entries(REGIONS).map(([k, v]) => html`<option value="${k}" ${value === k ? "selected" : ""}>${v}</option>`)}</select>`;
const typeSelect = (name, value, form) => html`<select name="${name}" ${form ? html`form="${form}"` : ""}>
  ${Object.entries(TYPES).map(([k, v]) => html`<option value="${k}" ${value === k ? "selected" : ""}>${v}</option>`)}</select>`;

export function render(ctx) {
  const locs = sortedLocations(ctx.state);
  return {
    title: "拠点",
    sub: "拠点名をクリックすると、納品・販売・在庫の明細を表示します。在庫は「在庫を更新」からファイルで更新します",
    body: html`
    <section class="card">
      ${locs.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>拠点</th><th>区分</th><th class="r">在庫数</th><th>最終更新</th><th></th></tr></thead>
        <tbody>${locs.map((l) => html`<tr>
          <td class="name"><a href="#/locations/${l.id}">${l.name}</a>${l.note ? html`<span class="sub">${l.note}</span>` : ""}</td>
          <td>${badge(l)}</td>
          <td class="r"><b>${n(locationTotal(ctx.state, l.id))}</b></td>
          <td class="muted nowrap">${l.updated_at ? dateTime(l.updated_at) : "未更新"}</td>
          <td class="r"><a class="btn sm" href="#/imports?location_id=${l.id}">${icon("upload")}在庫を更新</a></td>
        </tr>`)}</tbody></table></div>` : empty("拠点はまだありません。下のフォームから追加してください。")}
    </section>

    <section class="card">
      <div class="card-head"><h2>拠点を追加</h2></div>
      <form data-action="create" class="card-body toolbar">
        <input name="name" placeholder="拠点名（例：東京倉庫）" required class="grow">
        ${regionSelect("region", "JP")}${typeSelect("type", "WAREHOUSE")}
        <input name="note" placeholder="備考" class="grow">
        <button>${icon("plus")}追加</button>
      </form>
    </section>

    ${locs.length ? html`<section class="card"><details class="more card-body">
      <summary>拠点名・区分を編集する</summary>
      <div class="table-wrap" style="margin-top:12px"><table>
        <thead><tr><th>拠点名</th><th>地域</th><th>種別</th><th>備考</th><th></th></tr></thead>
        <tbody>${locs.map((l) => html`<tr>
          <td><input name="name" value="${l.name}" required form="loc-${l.id}"></td>
          <td>${regionSelect("region", l.region, `loc-${l.id}`)}</td>
          <td>${typeSelect("type", l.type, `loc-${l.id}`)}</td>
          <td><input name="note" value="${l.note}" form="loc-${l.id}"></td>
          <td class="nowrap r"><form id="loc-${l.id}" data-action="update" data-id="${l.id}" class="actions" style="justify-content:flex-end">
            <button class="ghost sm">保存</button>
            <button type="button" class="danger sm" data-click="remove" data-id="${l.id}" data-confirm="この拠点を削除しますか？">削除</button>
          </form></td></tr>`)}</tbody></table></div>
    </details></section>` : ""}`,
  };
}

function fields(form) {
  const f = new FormData(form);
  return { name: String(f.get("name") || "").trim(), region: f.get("region"), type: f.get("type"), note: String(f.get("note") || "") };
}

export const actions = {
  async create(ctx, form) {
    const v = fields(form);
    if (!v.name) return go("#/locations", { error: "拠点名を入力してください" });
    await mutate((W) => {
      saveLocation(W, v);
    });
    go("#/locations", { msg: `拠点「${v.name}」を登録しました` });
  },
  async update(ctx, form) {
    const id = form.dataset.id;
    const all = Object.fromEntries([...document.querySelectorAll(`[form="loc-${id}"]`)].map((el) => [el.name, el.value]));
    const v = { name: all.name.trim(), region: all.region, type: all.type, note: all.note };
    if (!v.name) return go("#/locations", { error: "拠点名を入力してください" });
    await mutate((W) => {
      const cur = W.locations.get(id);
      if (cur) saveLocation(W, { ...cur, ...v });
    });
    go("#/locations", { msg: "拠点を更新しました" });
  },
  async remove(ctx, el) {
    await mutate((W) => deleteLocation(W, el.dataset.id));
    go("#/locations", { msg: "拠点を削除しました" });
  },
};
