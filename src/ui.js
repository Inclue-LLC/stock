// 画面部品。html`...` は値を自動でエスケープする（raw() で囲んだものはそのまま）。

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(s);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function fmt(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

export function html(strings, ...vals) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += fmt(vals[i]);
  });
  return raw(out);
}

export const n = (v) => Number(v || 0).toLocaleString("ja-JP");
export const yen = (v) => (v === null || v === undefined ? "–" : `¥${n(v)}`);
export const pct = (v) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
export const shortDate = (iso) => iso.slice(2).replace(/-/g, "/");
export function dateTime(d) {
  if (!d) return "";
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 16);
}

const ICONS = {
  boxes: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  store: '<path d="M4 9h16l-1.5-5h-13Z"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>',
};
export const icon = (name) =>
  raw(`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`);

import { REGIONS, TYPES } from "./domain/inventory.js";

export const badge = (loc) =>
  html`<span class="chip r-${loc.region}">${REGIONS[loc.region]}</span><span class="chip t-${loc.type}">${TYPES[loc.type]}</span>`;

export function locationOptions(locations, selected = null, blank = null) {
  const groups = Object.keys(REGIONS).map((r) => {
    const items = locations.filter((l) => l.region === r);
    if (!items.length) return "";
    return html`<optgroup label="${REGIONS[r]}">${items.map((l) =>
      html`<option value="${l.id}" ${raw(selected === l.id ? "selected" : "")}>${l.name}（${TYPES[l.type]}）</option>`)}</optgroup>`;
  });
  return html`${blank ? html`<option value="">${blank}</option>` : ""}${groups}`;
}

export const delta = (v) =>
  html`<span class="num ${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v > 0 ? "+" : ""}${n(v)}</span>`;

export function pager(page, urlWith) {
  if (!page.total) return "";
  return html`<div class="pager">
    <span class="muted">${n(page.total)}件中 ${n(page.start)}–${n(page.end)}件</span>
    ${page.pages > 1 ? html`<div class="pager-links">
      ${page.page > 1 ? html`<a href="${urlWith({ page: page.page - 1 })}">‹ 前へ</a>` : html`<span class="disabled">‹ 前へ</span>`}
      <span class="current">${page.page} / ${page.pages}</span>
      ${page.page < page.pages ? html`<a href="${urlWith({ page: page.page + 1 })}">次へ ›</a>` : html`<span class="disabled">次へ ›</span>`}
    </div>` : ""}
  </div>`;
}

export const empty = (text, href = null, link = null) =>
  html`<div class="empty">${text}${href ? html` <a href="${href}">${link}</a>` : ""}</div>`;

export const dropzone = (title, hint, accept) => html`
  <label class="dropzone" data-dropzone>
    ${icon("file")}
    <strong>${title}</strong>
    <span class="hint">${hint}</span>
    <div class="fname"></div>
    <input type="file" name="file" accept="${accept}" required>
  </label>`;
