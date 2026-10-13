from sqlalchemy import func, select
from sqlalchemy.orm import Session

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
) -> Movement:
    stock = get_or_create_stock(db, product.id, location.id)
    delta = compute_delta(kind, stock.quantity, quantity)
    new_qty = stock.quantity + delta
    if new_qty < 0:
        raise StockError(
            f"{product.sku}（{location.name}）の在庫が不足しています: 現在 {stock.quantity}、出庫 {quantity}"
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
    )
    db.add(mv)
    return mv


def transfer(
    db: Session, *, product: Product, src: Location, dst: Location, quantity: int, note: str = ""
) -> None:
    if src.id == dst.id:
        raise StockError("移動元と移動先が同じです")
    if quantity <= 0:
        raise StockError("移動数量は1以上で入力してください")
    apply_movement(db, product=product, location=src, kind=MovementKind.TRANSFER_OUT,
                   quantity=quantity, note=note or f"→ {dst.name}")
    apply_movement(db, product=product, location=dst, kind=MovementKind.TRANSFER_IN,
                   quantity=quantity, note=note or f"← {src.name}")


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
        .order_by(Product.sku, Location.region, Location.type, Location.name)
    )
    if region:
        stmt = stmt.where(Location.region == region)
    if ltype:
        stmt = stmt.where(Location.type == ltype)
    if location_id:
        stmt = stmt.where(Location.id == location_id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Product.sku.ilike(like)) | (Product.name.ilike(like)))
    if not include_zero:
        stmt = stmt.where(Stock.quantity != 0)
    return stmt


# ---- 取込（ImportBatch） --------------------------------------------------------

def resolve_location(db: Session, name: str | None, default: Location | None) -> Location | None:
    if name:
        loc = db.scalar(select(Location).where(Location.name == name.strip()))
        if loc:
            return loc
        return None
    return default


def validate_batch(db: Session, batch: ImportBatch) -> list[dict]:
    """各行に product/location の解決結果とエラーを付けたプレビュー用リストを返す。"""
    preview = []
    pending: dict[tuple[str, int], int] = {}  # 同一ファイル内の累積（出庫時の在庫チェック用）
    for i, row in enumerate(batch.rows):
        item = dict(row, index=i, errors=[], product=None, location=None, current=None, after=None,
                    location_name=row.get("location"))
        product = db.scalar(select(Product).where(Product.sku == row["sku"]))
        item["product"] = product
        loc = resolve_location(db, row.get("location"), batch.location)
        item["location"] = loc
        if loc is None:
            item["errors"].append(
                f"拠点「{row.get('location')}」が見つかりません" if row.get("location") else "拠点が未指定です"
            )
        if product is None and not row.get("name"):
            item["errors"].append("未登録の商品で、商品名がありません")
        if row.get("quantity") is None:
            item["errors"].append("数量が読み取れません")
        if loc is not None and row.get("quantity") is not None:
            key = (row["sku"], loc.id)
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
                pending[key] = after
        preview.append(item)
    return preview


def get_current_qty(db: Session, product_id: int, location_id: int) -> int:
    qty = db.scalar(
        select(Stock.quantity).where(Stock.product_id == product_id, Stock.location_id == location_id)
    )
    return qty or 0


def apply_batch(db: Session, batch: ImportBatch, *, skip_errors: bool = True) -> tuple[int, int]:
    """取込を確定する。戻り値は (反映件数, スキップ件数)。"""
    if batch.status != "pending":
        raise StockError("この取込はすでに処理済みです")
    applied = skipped = 0
    created: dict[str, Product] = {}  # 同一ファイル内で新規登録した商品
    for item in validate_batch(db, batch):
        if item["errors"]:
            if not skip_errors:
                raise StockError(f"{item['index'] + 1}行目: {' / '.join(item['errors'])}")
            skipped += 1
            continue
        product = item["product"] or created.get(item["sku"])
        if product is None:
            product = Product(sku=item["sku"], name=item["name"], unit=item.get("unit") or "個")
            db.add(product)
            db.flush()
            created[item["sku"]] = product
        apply_movement(
            db,
            product=product,
            location=item["location"],
            kind=batch.kind,
            quantity=item["quantity"],
            source=batch.source,
            batch=batch,
            note=item.get("note") or batch.filename,
        )
        db.flush()
        applied += 1
    batch.status = "applied"
    return applied, skipped
