// xlsx の読み取り（セルの値だけ）。数式は Excel が保存した計算結果を使う。
// ExcelJS は計算結果が 0 の数式セルを空として読む不具合があるため、読み取りはこちらを使う。

import { strFromU8, unzipSync } from "fflate";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(s) {
  return s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? m;
    });
}

/** <t> 要素の文字列をつなげる（ふりがな <rPh> は除く）。 */
function textOf(xml) {
  const body = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) out += m[1] ?? "";
  return unescapeXml(out);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function resolvePath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function parseSheet(xml, shared) {
  const table = [];
  const rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
  const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let nextRow = 0;
  for (const rm of xml.matchAll(rowRe)) {
    const r = attr(rm[1], "r");
    const rowIdx = r ? Number(r) - 1 : nextRow;
    nextRow = rowIdx + 1;
    const row = [];
    let nextCol = 0;
    for (const cm of (rm[2] || "").matchAll(cellRe)) {
      const ref = attr(cm[1], "r");
      const col = ref ? colIndex(ref) : nextCol;
      nextCol = col + 1;
      const type = attr(cm[1], "t") || "n";
      const inner = cm[2] || "";
      const v = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
      let value = null;
      if (type === "s") value = v ? shared[Number(v[1])] ?? null : null;
      else if (type === "inlineStr") value = textOf(inner);
      else if (type === "str") value = v ? unescapeXml(v[1]) : null;
      else if (type === "b") value = v ? v[1] === "1" : null;
      else if (type === "e") value = null;
      else if (v && v[1] !== "") value = Number(v[1]);
      if (value === "") value = null;
      row[col] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    table[rowIdx] = row;
  }
  for (let i = 0; i < table.length; i++) if (!table[i]) table[i] = [];
  return table;
}

/** xlsx を [シート名, 2次元配列] の配列にする（日付は Excel のシリアル値のまま）。 */
export function readXlsx(data) {
  let files;
  try {
    files = unzipSync(new Uint8Array(data));
  } catch {
    throw new Error("Excel ファイルを開けませんでした（.xlsx 形式か確認してください）");
  }
  const text = (path) => (files[path] ? strFromU8(files[path]) : null);
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("Excel ファイルを開けませんでした（.xlsx 形式か確認してください）");
  const shared = [];
  const sst = text("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)) shared.push(textOf(m[1]));
  const rels = new Map();
  for (const m of (text("xl/_rels/workbook.xml.rels") || "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    rels.set(attr(m[1], "Id"), resolvePath("xl/workbook.xml", attr(m[1], "Target")));
  }
  const sheets = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1], "name");
    const rid = attr(m[1], "r:id") || attr(m[1], "id");
    const xml = text(rels.get(rid) || "");
    if (xml) sheets.push([name, parseSheet(xml, shared)]);
  }
  return sheets;
}

/** Excel の日付シリアル値を YYYY-MM-DD にする。 */
export function excelSerialToIso(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}
