import math
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from . import jan as jancode

from .models import (
    ImportBatch,
    Location,
    LocationType,
    Movement,
    MovementKind,
    Product,
    Region,
    Source,
    Stock,
)


class StockError(ValueError):
    pass


def get_or_create_stock(db: Session, product_id: int, location_id: int) -> Stock:
    stock = db.scalar(
        select(Stock).where(Stock.product_id == product_id, Stock.location_id == location_id)
    )
    if stock is None:
        stock = Stock(product_id=product_id, location_id=location_id, quantity=0)
        db.add(stock)
        db.flush()
    return stock


def compute_delta(kind: MovementKind, current: int, quantity: int) -> int:
    if quantity < 0:
        raise StockError("数量は0以上で入力してください")
    if kind in (MovementKind.IN, MovementKind.TRANSFER_IN):
        return quantity
    if kind in (MovementKind.OUT, MovementKind.TRANSFER_OUT):
        return -quantity
    if kind == MovementKind.SET:
        return quantity - current
    raise StockError(f"不明な区分: {kind}")


def apply_movement(
    db: Session,
    *,
    product: Product,
    location: Location,
    kind: MovementKind,
    quantity: int,
    source: Source = Source.MANUAL,
    batch: ImportBatch | None = None,
    note: str = "",
    on: date | None = None,
) -> Movement:
    stock = get_or_create_stock(db, product.id, location.id)
    delta = compute_delta(kind, stock.quantity, quantity)
    new_qty = stock.quantity + delta
    if new_qty < 0:
        raise StockError(
            f"{product.name}（{location.name}）の在庫が不足しています: 現在 {stock.quantity}、出庫 {quantity}"
        )
    stock.quantity = new_qty
    mv = Movement(
        product_id=product.id,
        location_id=location.id,
        kind=kind,
        delta=delta,
        quantity_after=new_qty,
        source=source,
        batch_id=batch.id if batch else None,
        note=note,
        date=on,
    )
    db.add(mv)
    return mv


def category_matrix(db: Session) -> dict[tuple[Region, LocationType], int]:
    """地域 × 拠点種別 ごとの在庫数合計。"""
    rows = db.execute(
        select(Location.region, Location.type, func.coalesce(func.sum(Stock.quantity), 0))
        .select_from(Location)
        .outerjoin(Stock, Stock.location_id == Location.id)
        .group_by(Location.region, Location.type)
    ).all()
    result = {(r, t): 0 for r in Region for t in LocationType}
    for region, ltype, total in rows:
        result[(region, ltype)] = int(total)
    return result


def product_search(stmt, q: str):
    """JAN・品番・商品名で絞り込む。JAN をスキャンした場合も前方一致で当たる。"""
    q = (q or "").strip()
    if not q:
        return stmt
    like = f"%{q}%"
    return stmt.where(or_(Product.jan.like(f"{q}%"), Product.sku.ilike(like), Product.name.ilike(like)))


def stock_query(
    *,
    region: Region | None = None,
    ltype: LocationType | None = None,
    location_id: int | None = None,
    q: str = "",
    include_zero: bool = False,
):
    stmt = (
        select(Stock)
        .join(Stock.product)
        .join(Stock.location)
        .order_by(Product.name, Product.jan, Location.region, Location.type, Location.name)
    )
    if region:
        stmt = stmt.where(Location.region == region)
    if ltype:
        stmt = stmt.where(Location.type == ltype)
    if location_id:
        stmt = stmt.where(Location.id == location_id)
    stmt = product_search(stmt, q)
    if not include_zero:
        stmt = stmt.where(Stock.quantity != 0)
    return stmt


CATEGORIES = [(r, t) for r in Region for t in LocationType]


def product_totals_query(q: str = "", only_in_stock: bool = False):
    """商品ごとに 地域×種別 の4区分と合計の在庫数を集計する。"""
    cols = [
        func.coalesce(func.sum(case((and_(Location.region == r, Location.type == t), Stock.quantity), else_=0)), 0)
        for r, t in CATEGORIES
    ]
    total = func.coalesce(func.sum(Stock.quantity), 0)
    stmt = (
        select(Product, *cols, total)
        .outerjoin(Stock, Stock.product_id == Product.id)
        .outerjoin(Location, Location.id == Stock.location_id)
        .group_by(Product.id)
        .order_by(Product.name, Product.jan)
    )
    if only_in_stock:
        stmt = stmt.having(total != 0)
    return product_search(stmt, q)


@dataclass
class Page:
    items: list
    page: int
    per_page: int
    total: int

    @property
    def pages(self) -> int:
        return max(1, math.ceil(self.total / self.per_page))

    @property
    def start(self) -> int:
        return 0 if self.total == 0 else (self.page - 1) * self.per_page + 1

    @property
    def end(self) -> int:
        return min(self.total, self.page * self.per_page)


def paginate(db: Session, stmt, page: int, per_page: int = 50, scalars: bool = True) -> Page:
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    page = max(1, min(page, max(1, math.ceil(total / per_page))))
    stmt = stmt.limit(per_page).offset((page - 1) * per_page)
    items = list(db.scalars(stmt) if scalars else db.execute(stmt))
    return Page(items=items, page=page, per_page=per_page, total=total)


# ---- 商品の特定 -------------------------------------------------------------------

def find_product(db: Session, jan: str = "", sku: str = "") -> tuple[Product | None, str | None, str | None]:
    """JAN（優先）または品番から商品を探す。戻り値: (商品, 正規化済みJAN, エラー)。

    JAN が正しい形式で未登録の場合は (None, jan, None) を返す（新規登録可能）。
    """
    if jan:
        code, err = jancode.try_normalize(jan)
        if err:
            return None, None, err
        return db.scalar(select(Product).where(Product.jan == code)), code, None
    if sku:
        found = db.scalars(select(Product).where(Product.sku == sku).limit(2)).all()
        if len(found) == 1:
            return found[0], found[0].jan, None
        if len(found) > 1:
            return None, None, f"品番「{sku}」の商品が複数あります。JANコードで指定してください"
        return None, None, f"品番「{sku}」の商品は未登録です（新規登録にはJANコードが必要です）"
    return None, None, "JANコードがありません"


# ---- 商品マスタ取込 -----------------------------------------------------------------

@dataclass
class ProductImportResult:
    created: int = 0
    updated: int = 0
    errors: list[str] = field(default_factory=list)


def import_products(db: Session, rows: list[dict]) -> ProductImportResult:
    """JAN をキーに商品を新規登録 / 更新する（空欄の項目は上書きしない）。"""
    result = ProductImportResult()
    seen: dict[str, Product] = {}
    for i, row in enumerate(rows, start=1):
        code, err = jancode.try_normalize(row.get("jan"))
        if err:
            result.errors.append(f"{i}件目: {err}")
            continue
        product = seen.get(code) or db.scalar(select(Product).where(Product.jan == code))
        if product is None:
            if not row.get("name"):
                result.errors.append(f"{i}件目: JAN {code} の商品名がありません")
                continue
            product = Product(jan=code, name=row["name"], sku=row.get("sku") or "", unit=row.get("unit") or "個",
                              note=row.get("note") or "", brand=row.get("brand") or "", price=row.get("price"))
            db.add(product)
            result.created += 1
        elif code not in seen:
            result.updated += 1
        for key in ("name", "sku", "unit", "note", "brand"):
            if row.get(key):
                setattr(product, key, row[key])
        if row.get("price") is not None:
            product.price = row["price"]
        seen[code] = product
    db.flush()
    return result


# ---- 在庫取込（ImportBatch） --------------------------------------------------------

def resolve_location(db: Session, name: str | None, default: Location | None) -> Location | None:
    if name:
        return db.scalar(select(Location).where(Location.name == name.strip()))
    return default


def validate_batch(db: Session, batch: ImportBatch) -> list[dict]:
    """各行に product/location の解決結果とエラーを付けたプレビュー用リストを返す。"""
    preview = []
    pending: dict[tuple[str, int], int] = {}  # 同一ファイル内の累積（出庫時の在庫チェック用）
    for i, row in enumerate(batch.rows):
        item = dict(row, index=i, errors=[], product=None, location=None, current=None, after=None,
                    location_name=row.get("location"), jan_code=None)
        product, code, err = find_product(db, row.get("jan") or "", row.get("sku") or "")
        item["product"], item["jan_code"] = product, code
        if err:
            item["errors"].append(err)
        elif product is None and not row.get("name"):
            item["errors"].append("未登録のJANで、商品名がありません")
        loc = resolve_location(db, row.get("location"), batch.location)
        item["location"] = loc
        if loc is None:
            item["errors"].append(
                f"拠点「{row.get('location')}」が見つかりません" if row.get("location") else "拠点が未指定です"
            )
        if row.get("quantity") is None:
            item["errors"].append("数量が読み取れません")
        if loc is not None and code and row.get("quantity") is not None:
            key = (code, loc.id)
            if key in pending:
                current = pending[key]
            elif product is not None:
                current = get_current_qty(db, product.id, loc.id)
            else:
                current = 0
            try:
                after = current + compute_delta(batch.kind, current, row["quantity"])
            except StockError as e:
                item["errors"].append(str(e))
            else:
                if after < 0:
                    item["errors"].append(f"在庫不足（現在 {current}）")
                item["current"], item["after"] = current, after
                if not item["errors"]:
                    pending[key] = after
        preview.append(item)
    return preview


def get_current_qty(db: Session, product_id: int, location_id: int) -> int:
    qty = db.scalar(
        select(Stock.quantity).where(Stock.product_id == product_id, Stock.location_id == location_id)
    )
    return qty or 0


def missing_stocks(db: Session, batch: ImportBatch, preview: list[dict]) -> list[Stock]:
    """在庫更新（棚卸）で「ファイルにない商品を0にする」とき、0にされる在庫。

    対象は、ファイル内で正常に読めた行の拠点のみ。
    """
    if not (batch.zero_missing and batch.kind == MovementKind.SET):
        return []
    in_file: dict[int, set[str]] = {}
    for item in preview:
        if not item["errors"]:
            in_file.setdefault(item["location"].id, set()).add(item["jan_code"])
    if not in_file:
        return []
    stocks = db.scalars(
        select(Stock).join(Stock.product).join(Stock.location)
        .where(Stock.location_id.in_(in_file), Stock.quantity != 0)
        .order_by(Location.name, Product.name)
    ).all()
    return [s for s in stocks if s.product.jan not in in_file[s.location_id]]


def apply_batch(db: Session, batch: ImportBatch, *, skip_errors: bool = True) -> tuple[int, int, int]:
    """取込を確定する。戻り値は (反映件数, スキップ件数, 0にした件数)。"""
    if batch.status != "pending":
        raise StockError("この取込はすでに処理済みです")
    applied = skipped = 0
    created: dict[str, Product] = {}  # 同一ファイル内で新規登録した商品
    preview = validate_batch(db, batch)
    missing = missing_stocks(db, batch, preview)
    for item in preview:
        if item["errors"]:
            if not skip_errors:
                raise StockError(f"{item['index'] + 1}行目: {' / '.join(item['errors'])}")
            skipped += 1
            continue
        code = item["jan_code"]
        product = item["product"] or created.get(code)
        if product is None:
            product = Product(jan=code, sku=item.get("sku") or "", name=item["name"],
                              unit=item.get("unit") or "個", brand=item.get("brand") or "", price=item.get("price"))
            db.add(product)
            db.flush()
            created[code] = product
        else:  # マスタの空欄（ブランド・上代）はファイルの値で補う
            if not product.brand and item.get("brand"):
                product.brand = item["brand"]
            if product.price is None and item.get("price") is not None:
                product.price = item["price"]
        apply_movement(
            db,
            product=product,
            location=item["location"],
            kind=batch.kind,
            quantity=item["quantity"],
            source=batch.source,
            batch=batch,
            note=item.get("note") or batch.filename,
            on=batch.date,
        )
        db.flush()
        applied += 1
    for stock in missing:
        apply_movement(db, product=stock.product, location=stock.location, kind=MovementKind.SET, quantity=0,
                       source=batch.source, batch=batch, note=f"{batch.filename} に記載なし", on=batch.date)
    batch.status = "applied"
    return applied, skipped, len(missing)


# ---- 拠点（店舗）別レポート ------------------------------------------------------------

@dataclass
class StoreRow:
    product: Product
    deliveries: dict  # 納品日 → 数量
    delivered: int = 0
    sold: int = 0
    adjusted: int = 0  # 在庫更新による差分（ロス・棚差など）
    stock: int = 0

    @property
    def sell_through(self) -> float | None:
        """消化率 = 販売数 ÷ 納品数"""
        return self.sold / self.delivered if self.delivered else None

    @property
    def sales_amount(self) -> int | None:
        return self.sold * self.product.price if self.product.price is not None else None

    @property
    def stock_amount(self) -> int | None:
        return self.stock * self.product.price if self.product.price is not None else None


@dataclass
class StoreReport:
    rows: list[StoreRow]
    delivery_dates: list[date]
    brands: list[str]

    def total(self, attr: str) -> int:
        return sum(getattr(r, attr) or 0 for r in self.rows)

    def delivery_total(self, d: date) -> int:
        return sum(r.deliveries.get(d, 0) for r in self.rows)

    @property
    def sell_through(self) -> float | None:
        delivered = self.total("delivered")
        return self.total("sold") / delivered if delivered else None


def store_report(db: Session, location: Location, brand: str = "", q: str = "") -> StoreReport:
    """拠点ごとに、商品別の 納品（日付別）・販売・在庫更新差分・現在庫 を集計する。"""
    rows: dict[int, StoreRow] = {}

    def row(product: Product) -> StoreRow:
        if product.id not in rows:
            rows[product.id] = StoreRow(product=product, deliveries={})
        return rows[product.id]

    movements = db.scalars(
        select(Movement).join(Movement.product).where(Movement.location_id == location.id)
    ).all()
    dates: set[date] = set()
    for m in movements:
        r = row(m.product)
        if m.kind in (MovementKind.IN, MovementKind.TRANSFER_IN):
            d = m.business_date
            r.deliveries[d] = r.deliveries.get(d, 0) + m.delta
            r.delivered += m.delta
            dates.add(d)
        elif m.kind in (MovementKind.OUT, MovementKind.TRANSFER_OUT):
            r.sold += -m.delta
        else:
            r.adjusted += m.delta
    for s in db.scalars(select(Stock).where(Stock.location_id == location.id)).all():
        row(s.product).stock = s.quantity

    all_rows = list(rows.values())
    brands = sorted({r.product.brand for r in all_rows if r.product.brand})
    result = all_rows
    if brand:
        result = [r for r in result if r.product.brand == brand]
    if q:
        ql = q.lower()
        result = [r for r in result if ql in r.product.name.lower() or r.product.jan.startswith(q)
                  or ql in (r.product.sku or "").lower()]
    result.sort(key=lambda r: (r.product.brand or "\uffff", r.product.name))
    return StoreReport(rows=result, delivery_dates=sorted(dates), brands=brands)
