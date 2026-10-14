// 画面の切り替え（URL の # 以降）・共通レイアウト・フォーム操作。

import { StockError } from "./domain/inventory.js";
import { esc, html, icon, raw } from "./ui.js";
import * as stocks from "./pages/stocks.js";
import * as locations from "./pages/locations.js";
import * as locationMaster from "./pages/locationMaster.js";
import * as locationDetail from "./pages/locationDetail.js";
import * as products from "./pages/products.js";
import * as productDetail from "./pages/productDetail.js";
import * as movements from "./pages/movements.js";
import * as imports from "./pages/imports.js";
import * as importPreview from "./pages/importPreview.js";
import * as ozImport from "./pages/ozImport.js";

const ROUTES = [
  [/^\/stocks$/, stocks],
  [/^\/locations$/, locations],
  [/^\/location-master$/, locationMaster],
  [/^\/locations\/([\w-]+)$/, locationDetail],
  [/^\/products$/, products],
  [/^\/products\/([\w-]+)$/, productDetail],
  [/^\/movements$/, movements],
  [/^\/imports\/oz$/, ozImport],
  [/^\/imports\/([\w-]+)$/, importPreview],
  [/^\/imports$/, imports],
];

// [リンク先, アイコン, 名前, この項目を選択中として表示する画面]
const NAV = [
  ["#/stocks", "boxes", "在庫一覧", ["/stocks"]],
  ["#/locations", "store", "拠点別", ["/locations"]],
  ["#/imports", "upload", "在庫の更新", ["/imports", "/movements"]],
  ["#/products", "tag", "商品マスタ", ["/products"]],
  ["#/location-master", "pin", "拠点マスタ", ["/location-master"]],
];

let root = null;
let getState = null;
let flash = {};
let formDirty = false;
let renderSeq = 0;
let current = null;

export function parseHash() {
  const h = location.hash.replace(/^#/, "") || "/stocks";
  const [path, qs = ""] = h.split("?");
  return { path, params: new URLSearchParams(qs) };
}

function context(route) {
  const { path, params } = route;
  return {
    path,
    params,
    state: getState(),
    q: (name) => params.get(name) || "",
    urlWith(changes = {}) {
      const p = new URLSearchParams(params);
      p.delete("page");
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === undefined || v === "") p.delete(k);
        else p.set(k, v);
      }
      const s = p.toString();
      return `#${path}${s ? `?${s}` : ""}`;
    },
  };
}

/** 画面を移動する（メッセージ付き）。同じ URL なら描き直す。メッセージは別の画面に移るまで表示する。 */
export function go(hash, message = {}) {
  flash = { ...message, hash };
  formDirty = false;
  if (location.hash === hash) render();
  else location.hash = hash;
}

function layout(route, page) {
  const nav = NAV.map(([href, ic, label, paths]) => {
    const active = paths.some((p) => route.path === p || route.path.startsWith(`${p}/`));
    return html`<a href="${href}" class="${active ? "active" : ""}">${icon(ic)}<span>${label}</span></a>`;
  });
  const f = flash.hash === location.hash ? flash : {};
  return html`
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#/stocks"><span class="logo">${icon("boxes")}</span><span>在庫管理</span></a>
      <nav>${nav}</nav>
    </aside>
    <main class="content">
      <header class="page-head">
        <div><h1>${page.title}</h1>${page.sub ? html`<p class="sub">${page.sub}</p>` : ""}</div>
        <div class="head-actions">${page.actions || ""}</div>
      </header>
      ${f.msg ? html`<div class="alert ok">${icon("check")}<span>${f.msg}</span></div>` : ""}
      ${f.error ? html`<div class="alert err">${icon("alert")}<span>${f.error}</span></div>` : ""}
      ${page.body}
    </main>
  </div>`;
}

function find(route) {
  for (const [re, mod] of ROUTES) {
    const m = route.path.match(re);
    if (m) return [mod, m.slice(1)];
  }
  return [null, []];
}

export async function render() {
  const route = parseHash();
  const [mod, args] = find(route);
  if (!mod) {
    location.hash = "#/stocks";
    return;
  }
  const seq = ++renderSeq;
  const ctx = { ...context(route), args };
  current = { mod, ctx };
  try {
    let page = mod.render(ctx);
    if (page instanceof Promise) {
      root.innerHTML = String(layout(route, loadingView(document.title.split("｜")[0] || "読み込み中")));
      page = await page;
    }
    if (seq !== renderSeq) return; // 読み込み中に別の画面へ移動した
    document.title = `${page.title}｜在庫管理`;
    root.innerHTML = String(layout(route, page));
    mod.mounted?.(ctx, root);
  } catch (e) {
    console.error(e);
    if (seq !== renderSeq) return;
    root.innerHTML = String(layout(route, { title: "エラー", body: html`<div class="alert err">${icon("alert")}<span>${e.message}</span></div>` }));
  }
}

/** データが変わったときの描き直し。入力中のフォームがある画面や、履歴を読む画面はそのままにする。 */
export function onDataChange() {
  if (!current) return render();
  if (formDirty || current.mod.live === false) return;
  render();
}

function busy(form, on) {
  for (const b of form.querySelectorAll("button")) b.classList.toggle("busy", on);
}

async function runAction(name, el, event) {
  const handler = current?.mod.actions?.[name];
  if (!handler) return;
  event.preventDefault();
  const form = el.tagName === "FORM" ? el : el.closest("form");
  if (form) busy(form, true);
  try {
    await handler({ ...current.ctx, state: getState() }, el, event);
  } catch (e) {
    console.error(e);
    const message = e instanceof StockError || e.name === "FirebaseError" || e instanceof Error ? e.message : String(e);
    flash = { error: message, hash: location.hash };
    formDirty = false;
    render();
  } finally {
    if (form) busy(form, false);
  }
}

export function start(el, stateGetter) {
  root = el;
  getState = stateGetter;
  window.addEventListener("hashchange", () => {
    formDirty = false;
    if (flash.hash !== location.hash) flash = {};
    render();
  });
  root.addEventListener("submit", (e) => {
    const form = e.target;
    if (form.dataset.action) runAction(form.dataset.action, form, e);
  });
  root.addEventListener("click", (e) => {
    const confirmEl = e.target.closest("[data-confirm]");
    if (confirmEl && !confirm(confirmEl.dataset.confirm)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const el = e.target.closest("[data-click]");
    if (el) runAction(el.dataset.click, el, e);
  }, true);
  root.addEventListener("input", (e) => {
    if (e.target.closest("form:not([data-search])")) formDirty = true;
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("[data-autosubmit]")) t.form.requestSubmit();
    if (t.matches("[data-dropzone] input[type=file]")) showFile(t);
  });
  for (const type of ["dragenter", "dragover"]) {
    root.addEventListener(type, (e) => {
      const zone = e.target.closest?.("[data-dropzone]");
      if (zone) {
        e.preventDefault();
        zone.classList.add("drag");
      }
    });
  }
  root.addEventListener("dragleave", (e) => e.target.closest?.("[data-dropzone]")?.classList.remove("drag"));
  root.addEventListener("drop", (e) => {
    const zone = e.target.closest?.("[data-dropzone]");
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove("drag");
    const input = zone.querySelector("input[type=file]");
    if (e.dataTransfer.files.length) {
      input.files = e.dataTransfer.files;
      showFile(input);
    }
  });
  render();
}

function showFile(input) {
  const label = input.closest("[data-dropzone]")?.querySelector(".fname");
  if (label) label.textContent = input.files.length ? input.files[0].name : "";
}

/** 検索フォーム（GET）の内容を URL にする。 */
export function searchHash(ctx, form, keep = []) {
  const p = new URLSearchParams();
  for (const k of keep) if (ctx.params.get(k)) p.set(k, ctx.params.get(k));
  for (const [k, v] of new FormData(form)) if (v !== "") p.set(k, v);
  const s = p.toString();
  return `#${ctx.path}${s ? `?${s}` : ""}`;
}

export function loadingView(title) {
  return { title, body: raw(`<div class="loading"><div class="spinner"></div>読み込み中…</div>`) };
}

export { esc };
