"""「OZ 納品数集計」Excel（キャナルシティ博多店・GiGO新大久保）を在庫管理システムに取り込む（初回移行用）。

使い方（stock フォルダで実行）:
    .venv/bin/python scripts/import_oz_workbook.py ファイル.xlsx --dry-run   # 確認のみ（保存しない）
    .venv/bin/python scripts/import_oz_workbook.py ファイル.xlsx             # 取り込む

取り込む内容:
- 商品マスタ: ブランド・商品名・JANコード・上代（JAN のない商品は JAN なしで登録）
- キャナルシティ博多店:
    納品 =「OZ納品数_商品別」の 2506 OZ（2025/06/01）・2512 OZ福岡（2025/12/01）・OZ福岡 4/21追加（2026/04/21）
    販売 =「キャナル販売データ」（週次は日付、月次は月末日）
    在庫 =「キャナル販売在庫」の最新在庫数（その時点の日付で在庫更新）
- GiGO新大久保:
    納品 =「GiGO新大久保」の納品日ごとの列
    販売 = 8月までの累計販売（推定）＋ 9月販売数、在庫 = 9月末残数
- 2512 OZ広島 は取り込まない。
- 販売数が納品記録を上回る商品（記録より前の納品があるもの）は、差分を「調整」として計上する。
- 同じシート内で1つの JAN が複数の商品に使われている場合、最初の行の商品に JAN を割り当て、
  2行目以降は他シートの同名商品の JAN を使う（見つからなければ JAN なしで登録）。
  チェックデジットが誤っている JAN も同様に商品名で照合する。結果は「注意」として表示する。
"""

import argparse
import calendar
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from openpyxl import load_workbook  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app import jan as jancode  # noqa: E402
from app import services  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.models import Location, LocationType, Movement, MovementKind, Product, Region, Source  # noqa: E402

CANAL = "キャナルシティ博多店"
GIGO = "GiGO新大久保"
CANAL_DELIVERIES = {"2506 OZ": date(2025, 6, 1), "2512 OZ福岡": date(2025, 12, 1), "OZ福岡 4/21追加": date(2026, 4, 21)}
GIGO_SEP_START, GIGO_AUG_END, GIGO_SEP_END = date(2026, 9, 1), date(2026, 8, 31), date(2026, 9, 30)


def month_end(ym: str) -> date:
    y, m = (int(x) for x in ym.split("/")[:2])
    return date(y, m, calendar.monthrange(y, m)[1])


def as_date(value) -> date | None:
    """'2026/09 月計' → 月末、'2025/02/24' → その日、datetime → 日付。"""
    if isinstance(value, datetime):
        return value.date()
    if not value:
        return None
    s = str(value)
    m = re.match(r"(\d{4})/(\d{1,2})/(\d{1,2})", s)
    if m:
        return date(int(m[1]), int(m[2]), int(m[3]))
    m = re.match(r"(\d{4})/(\d{1,2})", s)
    return month_end(f"{m[1]}/{m[2]}") if m else None


def num(value) -> int:
    return int(value) if isinstance(value, (int, float)) else 0


def norm_name(name) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(name or ""))).lower()


def header_index(ws, row: int) -> dict[str, int]:
    return {str(v).strip(): i for i, v in enumerate(next(ws.iter_rows(min_row=row, max_row=row, values_only=True)))
            if v is not None}


# (シート名, 1行目のデータ行, JAN列, 商品名列)
MASTER_SHEETS = [("OZ納品数_商品別", 5, 3, 2), ("GiGO新大久保", 5, 3, 2), ("キャナル販売在庫", 5, 3, 2),
                 ("キャナル販売データ", 2, 6, 7)]


class Importer:
    def __init__(self, db, wb):
        self.db, self.wb = db, wb
        self.products: dict[str, Product] = {}  # キー: JAN または "name:商品名"
        self.created = self.updated = 0
        self.warnings: list[str] = []
        self.fixed: dict[tuple[str, str], str | None] = {}  # (シート, 商品名) → 使う JAN（None = JAN なし）
        self.plan_jan_fixes()

    def plan_jan_fixes(self):
        """JAN の重複・誤りを、商品名で他シートと照合して補正する計画を立てる。"""
        by_name: dict[str, set[str]] = defaultdict(set)  # 正規化した商品名 → 正しい JAN
        suspect: list[tuple[str, str, str | None]] = []  # (シート, 商品名, 元の JAN)
        for title, start, jcol, ncol in MASTER_SHEETS:
            owner: dict[str, str] = {}  # JAN → このシートで最初に使った商品名
            for r in self.wb[title].iter_rows(min_row=start, values_only=True):
                name = r[ncol]
                if not name or name == "合計" or not r[jcol]:
                    continue
                code, err = jancode.try_normalize(r[jcol])
                if err:
                    suspect.append((title, name, str(r[jcol])))
                    continue
                first = owner.setdefault(code, name)
                if norm_name(first) != norm_name(name) and title != "キャナル販売データ":
                    suspect.append((title, name, code))
                else:
                    by_name[norm_name(name)].add(code)
        for title, name, original in suspect:
            candidates = by_name.get(norm_name(name), set()) - {original}
            new = next(iter(candidates)) if len(candidates) == 1 else None
            self.fixed[(title, name)] = new
            self.warnings.append(
                f"[{title}] {name}: JAN {original} は" + ("誤り" if not jancode.is_valid(original or "") else
                                                         "他の商品と重複")
                + (f" → 同名商品の JAN {new} を使用" if new else " → JAN なしで登録"))

    def jan_for(self, sheet: str, jan, name):
        return self.fixed.get((sheet, name), jan) if (sheet, name) in self.fixed else jan

    # ---- 商品 ----
    def product(self, jan, name, brand=None, price=None) -> Product | None:
        name = (str(name).strip() if name else "")
        code = None
        if jan:
            code, err = jancode.try_normalize(jan)
            if err:  # plan_jan_fixes で補正済みのはずだが念のため
                code = None
        if not code and not name:
            return None
        key = code or f"name:{name}"
        if key in self.products:
            p = self.products[key]
        else:
            if code:
                p = self.db.scalar(select(Product).where(Product.jan == code))
            else:
                p = self.db.scalar(select(Product).where(Product.jan.is_(None), Product.name == name))
            if p is None:
                p = Product(jan=code, name=name, brand="", unit="個")
                self.db.add(p)
                self.db.flush()
                self.created += 1
            else:
                self.updated += 1
            self.products[key] = p
        # マスタの空欄だけ補う（既に登録済みの内容は上書きしない）
        if not p.brand and brand:
            p.brand = str(brand).strip()
        if p.price is None and isinstance(price, (int, float)) and price:
            p.price = int(price)
        return p

    def load_master(self):
        for title in ("OZ納品数_商品別", "GiGO新大久保"):
            for r in self.wb[title].iter_rows(min_row=5, values_only=True):
                if r[2] and r[2] != "合計":
                    self.product(self.jan_for(title, r[3], r[2]), r[2], r[1], r[4])
        for r in self.wb["キャナル販売在庫"].iter_rows(min_row=5, values_only=True):
            if r[2] and r[2] != "合計":
                self.product(self.jan_for("キャナル販売在庫", r[3], r[2]), r[2], r[1])
        for r in self.wb["キャナル販売データ"].iter_rows(min_row=2, values_only=True):
            if r[6] or r[7]:
                self.product(self.jan_for("キャナル販売データ", r[6], r[7]), r[7], r[1])

    # ---- 在庫の増減 ----
    def move(self, p, loc, kind, qty, on, note):
        if kind != MovementKind.SET and qty <= 0:
            return
        services.apply_movement(self.db, product=p, location=loc, kind=kind, quantity=qty, source=Source.EXCEL,
                                note=note, on=on)
        self.db.flush()

    def stock(self, p, loc) -> int:
        self.db.flush()
        return services.get_current_qty(self.db, p.id, loc.id)

    def load_canal(self, loc):
        oz = self.wb["OZ納品数_商品別"]
        h = header_index(oz, 4)
        deliveries: dict[int, list] = defaultdict(list)
        for r in oz.iter_rows(min_row=5, values_only=True):
            if not r[2] or r[2] == "合計":
                continue
            p = self.product(self.jan_for("OZ納品数_商品別", r[3], r[2]), r[2])
            for col, d in CANAL_DELIVERIES.items():
                q = num(r[h[col]])
                if q:
                    deliveries[p.id].append((d, q, col))

        sales: dict[int, dict[date, int]] = defaultdict(lambda: defaultdict(int))
        for r in self.wb["キャナル販売データ"].iter_rows(min_row=2, values_only=True):
            if not (r[6] or r[7]) or not r[8]:
                continue
            p = self.product(self.jan_for("キャナル販売データ", r[6], r[7]), r[7])
            d = as_date(r[5]) or month_end(r[4])
            sales[p.id][d] += num(r[8])

        latest: dict[int, tuple[int, date]] = {}
        for r in self.wb["キャナル販売在庫"].iter_rows(min_row=5, values_only=True):
            if r[2] and r[2] != "合計" and r[9] is not None:
                p = self.product(self.jan_for("キャナル販売在庫", r[3], r[2]), r[2])
                latest[p.id] = (num(r[9]), as_date(r[10]) or GIGO_SEP_END)

        products = {p.id: p for p in self.products.values()}
        for pid in sorted(set(deliveries) | set(sales) | set(latest)):
            p = products[pid]
            delivered = sum(q for _, q, _ in deliveries[pid])
            sold = sum(sales[pid].values())
            if sold > delivered:  # 記録より前の納品（2024年からの販売分など）
                first = min(sales[pid]) if sales[pid] else date(2024, 4, 28)
                self.move(p, loc, MovementKind.SET, sold - delivered, first,
                          "記録外の入荷（販売実績から推定）")
            for d, q, col in sorted(deliveries[pid]):
                self.move(p, loc, MovementKind.IN, q, d, f"{col} 納品")
            for d, q in sorted(sales[pid].items()):
                self.move(p, loc, MovementKind.OUT, q, d, "キャナル売上報告")
            if pid in latest:
                q, d = latest[pid]
                if self.stock(p, loc) != q:
                    self.move(p, loc, MovementKind.SET, q, d, "売上報告の在庫数")

    def load_gigo(self, loc):
        ws = self.wb["GiGO新大久保"]
        h = header_index(ws, 4)
        dcols = []
        for title, i in h.items():
            m = re.match(r"(\d+)/(\d+)/(\d+)\s*納品", title.replace("\n", ""))
            if m:
                dcols.append((i, date(2000 + int(m[1]), int(m[2]), int(m[3]))))
        col = {k: next(i for t, i in h.items() if t.replace("\n", "").startswith(k))
               for k in ("9月 入庫数", "9月 販売数", "9月末 残数")}
        for r in ws.iter_rows(min_row=5, values_only=True):
            if not r[2] or r[2] == "合計":
                continue
            p = self.product(self.jan_for("GiGO新大久保", r[3], r[2]), r[2])
            delivered = 0
            for i, d in dcols:
                q = num(r[i])
                if q:
                    self.move(p, loc, MovementKind.IN, q, d, "納品")
                    delivered += q
            start, sold9, end9 = num(r[col["9月 入庫数"]]), num(r[col["9月 販売数"]]), num(r[col["9月末 残数"]])
            if not (delivered or start or sold9 or end9):
                continue
            if delivered:
                before = min(self.stock(p, loc), max(0, delivered - end9 - sold9))
                self.move(p, loc, MovementKind.OUT, before, GIGO_AUG_END,
                          "8月までの累計販売（推定：納品数−9月末残数−9月販売数）")
            if self.stock(p, loc) != start:
                self.move(p, loc, MovementKind.SET, start, GIGO_SEP_START,
                          "9月期首在庫" + ("（納品記録なし）" if not delivered else ""))
            self.move(p, loc, MovementKind.OUT, min(sold9, self.stock(p, loc)), GIGO_SEP_END, "9月販売")
            if self.stock(p, loc) != end9:
                self.move(p, loc, MovementKind.SET, end9, GIGO_SEP_END, "9月末残数")


def location(db, name) -> Location:
    loc = db.scalar(select(Location).where(Location.name == name))
    if loc is None:
        loc = Location(name=name, region=Region.JP, type=LocationType.CONSIGNMENT)
        db.add(loc)
        db.flush()
    return loc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--dry-run", action="store_true", help="内容を確認するだけで保存しない")
    args = ap.parse_args()

    init_db()
    wb = load_workbook(args.xlsx, data_only=True)
    with SessionLocal() as db:
        locs = {name: location(db, name) for name in (CANAL, GIGO)}
        for name, loc in locs.items():
            if db.scalar(select(func.count(Movement.id)).where(Movement.location_id == loc.id)):
                sys.exit(f"「{name}」にはすでに入出庫の記録があるため中止しました（二重取込の防止）。")
        imp = Importer(db, wb)
        imp.load_master()
        imp.load_canal(locs[CANAL])
        imp.load_gigo(locs[GIGO])
        db.flush()

        print(f"商品: 新規 {imp.created}件 / 既存 {imp.updated}件")
        for name, loc in locs.items():
            rep = services.store_report(db, loc)
            print(f"{name}: 商品 {len(rep.rows)}件 / 納品 {rep.total('delivered'):,} / 販売 {rep.total('sold'):,}"
                  f" / 調整 {rep.total('adjusted'):+,} / 在庫 {rep.total('stock'):,}")
        for w in imp.warnings:
            print("注意:", w)
        if args.dry_run:
            db.rollback()
            print("（--dry-run のため保存していません）")
        else:
            db.commit()
            print("取り込みました。")


if __name__ == "__main__":
    main()
