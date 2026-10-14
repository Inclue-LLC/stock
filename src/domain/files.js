// Excel / CSV / PDF ファイルを読み取り、明細（tables.js の行形式）にする。
// ライブラリは大きいので、必要になったときに読み込む。

import {
  PRODUCT_REQUIRED,
  STOCK_REQUIRED,
  headerMissing,
  newResult,
  parseSheets,
  rowsFromLines,
  rowsFromTable,
} from "./tables.js";
import { readXlsx } from "./xlsxRead.js";

export const SOURCE_BY_EXT = { xlsx: "EXCEL", xlsm: "EXCEL", csv: "CSV", pdf: "PDF" };

export function extOf(filename) {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

// ---- Excel ----------------------------------------------------------------------

/** xlsx を [シート名, 2次元配列] の配列にする。 */
export async function readWorkbook(data) {
  return readXlsx(data);
}

// ---- CSV ------------------------------------------------------------------------

export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---- PDF ------------------------------------------------------------------------

async function loadPdfjs() {
  if (typeof window === "undefined") {
    const nodeBuild = "pdfjs-dist/legacy/build/pdf.mjs"; // Node（テスト）用。ブラウザ用の bundle には含めない
    return import(/* @vite-ignore */ nodeBuild);
  }
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** ページの文字を行（y 座標）ごと・セル（x 座標が離れたところ）ごとにまとめる。 */
function pageLines(items) {
  const lines = [];
  const sorted = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width, s: it.str, h: Math.abs(it.transform[3]) || 10 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.3));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines.map((l) => {
    const items = l.items.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const it of items) {
      const prev = cells[cells.length - 1];
      if (prev && it.x - (prev.x + prev.w) < Math.max(2, it.h * 0.35)) {
        prev.s += (it.x - (prev.x + prev.w) > it.h * 0.15 ? " " : "") + it.s;
        prev.w = it.x + it.w - prev.x;
      } else cells.push({ ...it });
    }
    return cells;
  });
}

/** 見出し行の列位置を基準に、各行のセルを列に割り当てて2次元配列にする。 */
function linesToTable(lines, required) {
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].map((c) => c.s);
    const probe = newResult();
    if (!rowsFromTable([header], probe, "", required)) continue;
    const centers = lines[i].map((c) => c.x + c.w / 2);
    const table = [header];
    for (const line of lines.slice(i + 1)) {
      const row = new Array(centers.length).fill(null);
      for (const c of line) {
        const center = c.x + c.w / 2;
        let best = 0;
        centers.forEach((x, k) => {
          if (Math.abs(x - center) < Math.abs(centers[best] - center)) best = k;
        });
        row[best] = row[best] === null ? c.s : `${row[best]} ${c.s}`;
      }
      table.push(row);
    }
    tables.push(table);
    break;
  }
  return tables;
}

export async function parsePdf(data, required = STOCK_REQUIRED) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const result = newResult();
  let found = false;
  const texts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = pageLines(content.items);
    for (const table of linesToTable(lines, required)) {
      if (rowsFromTable(table, result, `p${p} `, required)) found = true;
    }
    texts.push(...lines.map((cells) => cells.map((c) => c.s).join(" ")));
  }
  if (found) return result;
  result.rows = rowsFromLines(texts);
  result.warnings.push(result.rows.length
    ? "PDF内に表が見つからなかったため、テキスト行から推定しました。内容を必ず確認してください"
    : "PDFから明細を読み取れませんでした（スキャン画像のPDFは非対応です）");
  return result;
}

// ---- 入口 ----------------------------------------------------------------------

/** 在庫明細の読み取り。戻り値: { source, rows, warnings } */
export async function parseStockFile(filename, data) {
  const ext = extOf(filename);
  if (ext === "xlsx" || ext === "xlsm") return { source: "EXCEL", ...parseSheets(await readWorkbook(data)) };
  if (ext === "csv") return { source: "CSV", ...parseCsv(data, STOCK_REQUIRED) };
  if (ext === "pdf") return { source: "PDF", ...(await parsePdf(data)) };
  throw new Error("対応形式は .xlsx / .xlsm / .csv / .pdf です");
}

/** 商品マスタ（JANコード・商品名・ブランド・上代など）の読み取り。 */
export async function parseProductFile(filename, data) {
  const ext = extOf(filename);
  if (ext === "xlsx" || ext === "xlsm") return parseSheets(await readWorkbook(data), PRODUCT_REQUIRED);
  if (ext === "csv") return parseCsv(data, PRODUCT_REQUIRED);
  throw new Error("商品マスタの対応形式は .xlsx / .xlsm / .csv です");
}

function parseCsv(data, required) {
  const bytes = new Uint8Array(data);
  let decodedAny = false;
  // 文字コードを順に試し、見出し行が見つかったものを使う（GBK が Shift_JIS として読めてしまう場合への対策）
  for (const enc of ["utf-8", "shift_jis", "gb18030"]) {
    let text;
    try {
      text = new TextDecoder(enc, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      continue;
    }
    decodedAny = true;
    const result = newResult();
    if (rowsFromTable(parseCsvText(text), result, "", required)) return result;
  }
  return { rows: [], warnings: [decodedAny ? headerMissing(required) : "文字コードを判別できませんでした"] };
}
