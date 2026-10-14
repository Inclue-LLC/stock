import { REGIONS, TYPES, locationTotal, sortedLocations } from "../domain/inventory.js";
import { badge, dateTime, empty, html, icon, n } from "../ui.js";

export function render(ctx) {
  const locs = sortedLocations(ctx.state);
  const groups = Object.keys(REGIONS).flatMap((r) => Object.keys(TYPES).map((t) => [r, t]))
    .map(([r, t]) => [`${REGIONS[r]}・${TYPES[t]}`, locs.filter((l) => l.region === r && l.type === t)])
    .filter(([, items]) => items.length);
  return {
    title: "拠点別",
    sub: "拠点名をクリックすると、納品・販売・在庫の明細を表示します",
    body: locs.length ? html`<section class="card"><div class="table-wrap"><table>
      <thead><tr><th>拠点</th><th>区分</th><th class="r">品目数</th><th class="r">在庫数</th><th>最終更新</th><th></th></tr></thead>
      <tbody>${groups.map(([label, items]) => html`
        <tr class="group-row"><td colspan="6"><b>${label}</b> <span class="muted">${items.length}拠点</span></td></tr>
        ${items.map((l) => {
          const lines = [...(ctx.state.stocks.get(l.id)?.values() || [])].filter((s) => s.q !== 0).length;
          return html`<tr>
            <td class="name"><a href="#/locations/${l.id}">${l.name}</a>${l.note ? html`<span class="sub">${l.note}</span>` : ""}</td>
            <td>${badge(l)}</td>
            <td class="r">${n(lines)}</td>
            <td class="r"><b>${n(locationTotal(ctx.state, l.id))}</b></td>
            <td class="muted nowrap">${l.updated_at ? dateTime(l.updated_at) : "未更新"}</td>
            <td class="r"><a class="btn sm" href="#/imports?location_id=${l.id}">${icon("upload")}在庫を更新</a></td>
          </tr>`;
        })}`)}</tbody></table></div></section>`
      : html`<section class="card">${empty("拠点はまだありません。", "#/location-master", "拠点マスタで登録する")}</section>`,
  };
}
