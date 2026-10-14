// 「OZ 納品数集計」Excel（キャナルシティ博多店・GiGO新大久保）の一括取込（初回移行用）。
//
// 取り込む内容:
// - 商品マスタ: ブランド・商品名・JANコード・上代（JAN のない商品は JAN なしで登録）
// - キャナルシティ博多店:
//     納品 =「OZ納品数_商品別」の 2506 OZ（2025/06/01）・2512 OZ福岡（2025/12/01）・OZ福岡 4/21追加（2026/04/21）
//     販売 =「キャナル販売データ」（週次は日付、月次は月末日）
//     在庫 =「キャナル販売在庫」の最新在庫数（その時点の日付で在庫更新）
// - GiGO新大久保:
//     納品 =「GiGO新大久保」の納品日ごとの列
//     販売 = 8月までの累計販売（推定）＋ 9月販売数、在庫 = 9月末残数
// - 2512 OZ広島 は取り込まない。
// - 販売数が納品記録を上回る商品（記録より前の納品があるもの）は、差分を「調整」として計上する。
// - 同じシート内で1つの JAN が複数の商品に使われている場合、最初の行の商品に JAN を割り当て、
//   2行目以降は他シートの同名商品の JAN を使う（見つからなければ JAN なしで登録）。
//   チェックデジットが誤っている JAN も同様に商品名で照合する。結果は「注意」として返す。

import { isValid, tryNormalize } from "./jan.js";
import { excelSerialToIso } from "./xlsxRead.js";
import {
  applyMovement,
  currentQty,
  locationByName,
  productByJan,
  productsByName,
  saveLocation,
  saveProduct,
  storeReport,
} from "./inventory.js";

export const CANAL = "キャナルシティ博多店";
export const GIGO = "GiGO新大久保";
const CANAL_DELIVERIES = { "2506 OZ": "2025-06-01", "2512 OZ福岡": "2025-12-01", "OZ福岡 4/21追加": "2026-04-21" };
const GIGO_SEP_START = "2026-09-01";
const GIGO_AUG_END = "2026-08-31";
const GIGO_SEP_END = "2026-09-30";
// [シート名, データの先頭行(0始まり), JAN列, 商品名列]
const MASTER_SHEETS = [["OZ納品数_商品別", 4, 3, 2], ["GiGO新大久保", 4, 3, 2], ["キャナル販売在庫", 4, 3, 2],
  ["キャナル販売データ", 1, 6, 7]];

const pad = (n) => String(n).padStart(2, "0");

function monthEnd(ym) {
  const [y, m] = String(ym).split("/").map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** '2026/09 月計' → 月末、'2025/02/24' → その日、日付セル → その日。 */
function asDate(value) {
  if (typeof value === "number") return excelSerialToIso(value);
  if (value instanceof Date) return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  if (!value) return null;
  const s = String(value);
  let m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{4})\/(\d{1,2})/);
  return m ? monthEnd(`${m[1]}/${m[2]}`) : null;
}

const num = (v) => (typeof v === "number" ? Math.trunc(v) : 0);
const normName = (name) => String(name ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const cleanTitle = (t) => String(t ?? "").replace(/\n/g, "").trim();

class Importer {
  constructor(W, sheets) {
    this.W = W;
    this.sheets = sheets;
    this.products = new Map(); // キー: JAN または "name:商品名"
    this.created = 0;
    this.updated = 0;
    this.warnings = [];
    this.fixed = new Map(); // "シート\t商品名" → 使う JAN（null = JAN なし）
    this.planJanFixes();
  }

  sheet(title) {
    const t = this.sheets.get(title);
    if (!t) throw new Error(`シート「${title}」が見つかりません。OZ納品数集計のファイルを選んでください`);
    return t;
  }

  rows(title, start) {
    return this.sheet(title).slice(start);
  }

  /** JAN の重複・誤りを、商品名で他シートと照合して補正する計画を立てる。 */
  planJanFixes() {
    const byName = new Map(); // 正規化した商品名 → 正しい JAN の集合
    const suspect = [];
    for (const [title, start, jcol, ncol] of MASTER_SHEETS) {
      const owner = new Map(); // JAN → このシートで最初に使った商品名
      for (const r of this.rows(title, start)) {
        const name = r[ncol];
        if (!name || name === "合計" || !r[jcol]) continue;
        const [code, err] = tryNormalize(r[jcol]);
        if (err) {
          suspect.push([title, name, String(r[jcol])]);
          continue;
        }
        if (!owner.has(code)) owner.set(code, name);
        if (normName(owner.get(code)) !== normName(name) && title !== "キャナル販売データ") {
          suspect.push([title, name, code]);
        } else {
          if (!byName.has(normName(name))) byName.set(normName(name), new Set());
          byName.get(normName(name)).add(code);
        }
      }
    }
    for (const [title, name, original] of suspect) {
      const candidates = [...(byName.get(normName(name)) || [])].filter((c) => c !== original);
      const replacement = candidates.length === 1 ? candidates[0] : null;
      this.fixed.set(`${title}\t${name}`, replacement);
      this.warnings.push(`[${title}] ${name}: JAN ${original} は${isValid(original) ? "他の商品と重複" : "誤り"}`
        + (replacement ? ` → 同名商品の JAN ${replacement} を使用` : " → JAN なしで登録"));
    }
  }

  janFor(sheet, jan, name) {
    const key = `${sheet}\t${name}`;
    return this.fixed.has(key) ? this.fixed.get(key) : jan;
  }

  product(jan, name, brand = null, price = null) {
    name = name ? String(name).trim() : "";
    let code = null;
    if (jan) {
      const [c, err] = tryNormalize(jan);
      code = err ? null : c;
    }
    if (!code && !name) return null;
    const key = code || `name:${name}`;
    let p = this.products.get(key);
    if (!p) {
      p = code ? productByJan(this.W, code) : productsByName(this.W, name, true)[0] || null;
      if (!p) {
        p = saveProduct(this.W, { jan: code, name, brand: "", unit: "個" });
        this.created++;
      } else this.updated++;
      this.products.set(key, p);
    }
    // マスタの空欄だけ補う（既に登録済みの内容は上書きしない）
    if (!p.brand && brand) p.brand = String(brand).trim();
    if (p.price == null && typeof price === "number" && price) p.price = Math.trunc(price);
    saveProduct(this.W, p);
    return p;
  }

  loadMaster() {
    for (const title of ["OZ納品数_商品別", "GiGO新大久保"]) {
      for (const r of this.rows(title, 4)) {
        if (r[2] && r[2] !== "合計") this.product(this.janFor(title, r[3], r[2]), r[2], r[1], r[4]);
      }
    }
    for (const r of this.rows("キャナル販売在庫", 4)) {
      if (r[2] && r[2] !== "合計") this.product(this.janFor("キャナル販売在庫", r[3], r[2]), r[2], r[1]);
    }
    for (const r of this.rows("キャナル販売データ", 1)) {
      if (r[6] || r[7]) this.product(this.janFor("キャナル販売データ", r[6], r[7]), r[7], r[1]);
    }
  }

  move(p, loc, kind, qty, date, note) {
    if (kind !== "SET" && qty <= 0) return;
    applyMovement(this.W, { productId: p.id, locationId: loc.id, kind, quantity: qty, date, note });
  }

  stock(p, loc) {
    return currentQty(this.W, loc.id, p.id);
  }

  loadCanal(loc) {
    const oz = this.sheet("OZ納品数_商品別");
    const header = new Map((oz[3] || []).map((v, i) => [cleanTitle(v), i]));
    const deliveries = new Map();
    for (const r of oz.slice(4)) {
      if (!r[2] || r[2] === "合計") continue;
      const p = this.product(this.janFor("OZ納品数_商品別", r[3], r[2]), r[2]);
      for (const [col, d] of Object.entries(CANAL_DELIVERIES)) {
        const q = num(r[header.get(col)]);
        if (q) {
          if (!deliveries.has(p.id)) deliveries.set(p.id, []);
          deliveries.get(p.id).push([d, q, col]);
        }
      }
    }
    const sales = new Map();
    for (const r of this.rows("キャナル販売データ", 1)) {
      if (!(r[6] || r[7]) || !r[8]) continue;
      const p = this.product(this.janFor("キャナル販売データ", r[6], r[7]), r[7]);
      const d = asDate(r[5]) || monthEnd(r[4]);
      if (!sales.has(p.id)) sales.set(p.id, new Map());
      sales.get(p.id).set(d, (sales.get(p.id).get(d) || 0) + num(r[8]));
    }
    const latest = new Map();
    for (const r of this.rows("キャナル販売在庫", 4)) {
      if (r[2] && r[2] !== "合計" && r[9] !== null && r[9] !== undefined) {
        const p = this.product(this.janFor("キャナル販売在庫", r[3], r[2]), r[2]);
        latest.set(p.id, [num(r[9]), asDate(r[10]) || GIGO_SEP_END]);
      }
    }
    const ids = [...new Set([...deliveries.keys(), ...sales.keys(), ...latest.keys()])].sort();
    for (const pid of ids) {
      const p = this.W.products.get(pid);
      const dels = (deliveries.get(pid) || []).sort();
      const sold = [...(sales.get(pid) || new Map())].sort();
      const delivered = dels.reduce((a, [, q]) => a + q, 0);
      const soldTotal = sold.reduce((a, [, q]) => a + q, 0);
      if (soldTotal > delivered) { // 記録より前の納品（2024年からの販売分など）
        this.move(p, loc, "SET", soldTotal - delivered, sold.length ? sold[0][0] : "2024-04-28",
          "記録外の入荷（販売実績から推定）");
      }
      for (const [d, q, col] of dels) this.move(p, loc, "IN", q, d, `${col} 納品`);
      for (const [d, q] of sold) this.move(p, loc, "OUT", q, d, "キャナル売上報告");
      if (latest.has(pid)) {
        const [q, d] = latest.get(pid);
        if (this.stock(p, loc) !== q) this.move(p, loc, "SET", q, d, "売上報告の在庫数");
      }
    }
  }

  loadGigo(loc) {
    const ws = this.sheet("GiGO新大久保");
    const titles = (ws[3] || []).map(cleanTitle);
    const dcols = [];
    titles.forEach((t, i) => {
      const m = t.match(/^(\d+)\/(\d+)\/(\d+)\s*納品/);
      if (m) dcols.push([i, `20${pad(m[1])}-${pad(m[2])}-${pad(m[3])}`]);
    });
    const col = (prefix) => titles.findIndex((t) => t.startsWith(prefix));
    const cStart = col("9月 入庫数");
    const cSold = col("9月 販売数");
    const cEnd = col("9月末 残数");
    for (const r of ws.slice(4)) {
      if (!r[2] || r[2] === "合計") continue;
      const p = this.product(this.janFor("GiGO新大久保", r[3], r[2]), r[2]);
      let delivered = 0;
      for (const [i, d] of dcols) {
        const q = num(r[i]);
        if (q) {
          this.move(p, loc, "IN", q, d, "納品");
          delivered += q;
        }
      }
      const start = num(r[cStart]);
      const sold9 = num(r[cSold]);
      const end9 = num(r[cEnd]);
      if (!(delivered || start || sold9 || end9)) continue;
      if (delivered) {
        const before = Math.min(this.stock(p, loc), Math.max(0, delivered - end9 - sold9));
        this.move(p, loc, "OUT", before, GIGO_AUG_END, "8月までの累計販売（推定：納品数−9月末残数−9月販売数）");
      }
      if (this.stock(p, loc) !== start) {
        this.move(p, loc, "SET", start, GIGO_SEP_START, "9月期首在庫" + (delivered ? "" : "（納品記録なし）"));
      }
      this.move(p, loc, "OUT", Math.min(sold9, this.stock(p, loc)), GIGO_SEP_END, "9月販売");
      if (this.stock(p, loc) !== end9) this.move(p, loc, "SET", end9, GIGO_SEP_END, "9月末残数");
    }
  }
}

/**
 * 取り込みを W（working() の作業コピー）に対して行う。
 * sheets: Map<シート名, 2次元配列>。すでに記録がある店舗があれば Error。
 */
export function runOzImport(W, sheets) {
  for (const name of [CANAL, GIGO]) {
    const loc = locationByName(W, name);
    if (loc && (W.stocks.get(loc.id)?.size || 0) > 0) {
      throw new Error(`「${name}」にはすでに在庫の記録があるため中止しました（二重取込の防止）。`);
    }
  }
  const locs = {};
  for (const name of [CANAL, GIGO]) {
    locs[name] = locationByName(W, name) || saveLocation(W, { name, region: "JP", type: "CONSIGNMENT" });
  }
  const imp = new Importer(W, sheets);
  imp.loadMaster();
  imp.loadCanal(locs[CANAL]);
  imp.loadGigo(locs[GIGO]);
  const stores = Object.entries(locs).map(([name, loc]) => {
    const rep = storeReport(W, loc.id);
    const f = (n) => n.toLocaleString("ja-JP");
    return `${name}: 商品 ${rep.rows.length}件 / 納品 ${f(rep.total("delivered"))} / 販売 ${f(rep.total("sold"))}`
      + ` / 調整 ${rep.total("adjusted") >= 0 ? "+" : ""}${f(rep.total("adjusted"))} / 在庫 ${f(rep.total("stock"))}`;
  });
  return { created: imp.created, updated: imp.updated, warnings: imp.warnings, stores };
}
