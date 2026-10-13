"""Firestore への保存と、拠点・商品・在庫のメモリキャッシュ。

- 拠点・商品・在庫（店舗別明細用の累計を含む）は起動時に読み込んでメモリに持つ。
  Cloud Run の最大インスタンス数を 1 にして運用するため、メモリ上の内容が常に最新になる。
- 入出庫履歴・取込バッチは必要なときに Firestore から読む。
- 書き込みは writing() の中でまとめ、最後に一括で保存する。途中で失敗したらキャッシュを捨てて読み直す。
"""

import json
import os
import threading
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime

from .models import (
    JST,
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

BATCH_LIMIT = 450  # Firestore の1回の一括書き込みは最大500件

# 1リクエストずつ順番に処理する（キャッシュの整合性を保つため。利用者が少ない前提）
request_lock = threading.Lock()


def _d(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _ts(value) -> datetime:
    return value.astimezone(JST) if isinstance(value, datetime) else datetime.now(JST)


class DuplicateError(ValueError):
    pass


class Store:
    def __init__(self, client=None):
        self._client = client
        self._loaded = False
        self.locations: dict[str, Location] = {}
        self.products: dict[str, Product] = {}
        self.stocks: dict[tuple[str, str], Stock] = {}
        self._pending: dict[str, tuple] | None = None  # path → ("set", data) / ("delete", None)

    # ---- 接続 -------------------------------------------------------------------
    @property
    def client(self):
        if self._client is None:
            from google.cloud import firestore

            project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("FIREBASE_PROJECT")
            self._client = firestore.Client(project=project) if project else firestore.Client()
        return self._client

    def col(self, name: str):
        return self.client.collection(name)

    def new_id(self, collection: str) -> str:
        return self.col(collection).document().id

    # ---- キャッシュ -----------------------------------------------------------------
    def reset(self):
        self._loaded = False
        self.locations, self.products, self.stocks = {}, {}, {}

    def ensure_loaded(self):
        if self._loaded:
            return
        locations, products, stocks = {}, {}, {}
        for doc in self.col("locations").stream():
            d = doc.to_dict()
            locations[doc.id] = Location(id=doc.id, name=d["name"], region=Region(d["region"]),
                                         type=LocationType(d["type"]), note=d.get("note", ""),
                                         updated_at=_ts(d["updated_at"]) if d.get("updated_at") else None)
        for doc in self.col("products").stream():
            d = doc.to_dict()
            products[doc.id] = Product(id=doc.id, name=d["name"], jan=d.get("jan"), sku=d.get("sku", ""),
                                       brand=d.get("brand", ""), price=d.get("price"), unit=d.get("unit", "個"),
                                       note=d.get("note", ""))
        for doc in self.col("stocks").stream():
            d = doc.to_dict()
            p, loc = products.get(d["product_id"]), locations.get(d["location_id"])
            if p is None or loc is None:
                continue
            stocks[(p.id, loc.id)] = Stock(
                product=p, location=loc, quantity=d.get("quantity", 0), delivered=d.get("delivered", 0),
                sold=d.get("sold", 0), adjusted=d.get("adjusted", 0),
                deliveries={date.fromisoformat(k): v for k, v in (d.get("deliveries") or {}).items()},
            )
        self.locations, self.products, self.stocks = locations, products, stocks
        self._loaded = True

    # ---- 読み取り（メモリ） -----------------------------------------------------------
    def all_locations(self) -> list[Location]:
        self.ensure_loaded()
        order = {r: i for i, r in enumerate(Region)}
        torder = {t: i for i, t in enumerate(LocationType)}
        return sorted(self.locations.values(), key=lambda x: (order[x.region], torder[x.type], x.name))

    def location(self, location_id: str | None) -> Location | None:
        self.ensure_loaded()
        return self.locations.get(location_id) if location_id else None

    def location_by_name(self, name: str) -> Location | None:
        self.ensure_loaded()
        name = name.strip()
        return next((x for x in self.locations.values() if x.name == name), None)

    def all_products(self) -> list[Product]:
        self.ensure_loaded()
        return sorted(self.products.values(), key=lambda p: (p.name, p.jan or ""))

    def product(self, product_id: str | None) -> Product | None:
        self.ensure_loaded()
        return self.products.get(product_id) if product_id else None

    def product_by_jan(self, jan: str) -> Product | None:
        self.ensure_loaded()
        return next((p for p in self.products.values() if p.jan == jan), None)

    def products_by_sku(self, sku: str) -> list[Product]:
        self.ensure_loaded()
        return [p for p in self.products.values() if p.sku == sku]

    def products_by_name(self, name: str, jan_none_only: bool = False) -> list[Product]:
        self.ensure_loaded()
        name = name.strip()
        return [p for p in self.products.values() if p.name == name and (p.jan is None or not jan_none_only)]

    def stock(self, product_id: str, location_id: str) -> Stock | None:
        self.ensure_loaded()
        return self.stocks.get((product_id, location_id))

    def all_stocks(self) -> list[Stock]:
        self.ensure_loaded()
        return list(self.stocks.values())

    def stocks_for_location(self, location_id: str) -> list[Stock]:
        return [s for s in self.all_stocks() if s.location.id == location_id]

    def stocks_for_product(self, product_id: str) -> list[Stock]:
        return [s for s in self.all_stocks() if s.product.id == product_id]

    # ---- 書き込み -------------------------------------------------------------------
    @contextmanager
    def writing(self) -> Iterator["Store"]:
        """この中で行った save_* / add_* / delete_* を最後にまとめて Firestore に保存する。"""
        if self._pending is not None:  # 入れ子の場合は外側でまとめて保存
            yield self
            return
        self.ensure_loaded()
        self._pending = {}
        try:
            yield self
            ops = list(self._pending.items())
            for i in range(0, len(ops), BATCH_LIMIT):
                wb = self.client.batch()
                for path, (op, data) in ops[i:i + BATCH_LIMIT]:
                    ref = self.client.document(path)
                    wb.set(ref, data) if op == "set" else wb.delete(ref)
                wb.commit()
        except BaseException:
            self.reset()  # メモリの変更を破棄し、次回 Firestore から読み直す
            raise
        finally:
            self._pending = None

    def _put(self, path: str, data: dict | None):
        if self._pending is None:
            raise RuntimeError("書き込みは store.writing() の中で行ってください")
        self._pending[path] = ("delete", None) if data is None else ("set", data)

    def save_location(self, loc: Location) -> Location:
        dup = self.location_by_name(loc.name)
        if dup is not None and dup.id != loc.id:
            raise DuplicateError(f"拠点「{loc.name}」はすでに登録されています")
        loc.id = loc.id or self.new_id("locations")
        self.locations[loc.id] = loc
        self._put(f"locations/{loc.id}", {"name": loc.name, "region": loc.region.value, "type": loc.type.value,
                                          "note": loc.note, "updated_at": loc.updated_at})
        return loc

    def delete_location(self, loc: Location):
        for s in self.stocks_for_location(loc.id):
            self._delete_stock(s)
        self.locations.pop(loc.id, None)
        self._put(f"locations/{loc.id}", None)

    def save_product(self, p: Product) -> Product:
        if p.jan:
            dup = self.product_by_jan(p.jan)
            if dup is not None and dup.id != p.id:
                raise DuplicateError(f"JANコード「{p.jan}」はすでに登録されています")
        p.id = p.id or self.new_id("products")
        self.products[p.id] = p
        self._put(f"products/{p.id}", {"name": p.name, "jan": p.jan, "sku": p.sku, "brand": p.brand,
                                       "price": p.price, "unit": p.unit, "note": p.note})
        return p

    def delete_product(self, p: Product):
        for s in self.stocks_for_product(p.id):
            self._delete_stock(s)
        self.products.pop(p.id, None)
        self._put(f"products/{p.id}", None)

    def get_or_create_stock(self, product: Product, location: Location) -> Stock:
        s = self.stock(product.id, location.id)
        if s is None:
            s = Stock(product=product, location=location)
            self.stocks[(product.id, location.id)] = s
        return s

    def save_stock(self, s: Stock):
        self._put(f"stocks/{s.key}", {
            "product_id": s.product.id, "location_id": s.location.id, "quantity": s.quantity,
            "delivered": s.delivered, "sold": s.sold, "adjusted": s.adjusted,
            "deliveries": {d.isoformat(): q for d, q in s.deliveries.items()},
        })

    def _delete_stock(self, s: Stock):
        self.stocks.pop((s.product.id, s.location.id), None)
        self._put(f"stocks/{s.key}", None)

    def add_movement(self, m: Movement) -> Movement:
        m.id = m.id or self.new_id("movements")
        self._put(f"movements/{m.id}", {
            "product_id": m.product.id, "location_id": m.location.id, "kind": m.kind.value, "delta": m.delta,
            "quantity_after": m.quantity_after, "source": m.source.value, "batch_id": m.batch_id,
            "note": m.note, "date": m.date.isoformat() if m.date else None, "created_at": m.created_at,
        })
        return m

    def save_batch(self, b: ImportBatch) -> ImportBatch:
        b.id = b.id or self.new_id("import_batches")
        self._put(f"import_batches/{b.id}", {
            "filename": b.filename, "source": b.source.value, "kind": b.kind.value,
            "location_id": b.location_id, "status": b.status, "zero_missing": b.zero_missing,
            "date": b.date.isoformat() if b.date else None, "warnings": b.warnings[:200],
            "rows_z": zlib.compress(json.dumps(b.rows, ensure_ascii=False).encode()),  # 1MB 制限対策で圧縮
            "row_count": len(b.rows), "created_at": b.created_at,
        })
        return b

    # ---- 履歴（Firestore から読む） ----------------------------------------------------
    def _movement(self, doc) -> Movement | None:
        d = doc.to_dict()
        p, loc = self.product(d["product_id"]), self.location(d["location_id"])
        if p is None or loc is None:
            return None
        return Movement(id=doc.id, product=p, location=loc, kind=MovementKind(d["kind"]), delta=d["delta"],
                        quantity_after=d["quantity_after"], source=Source(d.get("source", "MANUAL")),
                        batch_id=d.get("batch_id"), note=d.get("note", ""), date=_d(d.get("date")),
                        created_at=_ts(d.get("created_at")))

    def movements(self, *, location_id: str | None = None, product_id: str | None = None,
                  batch_id: str | None = None, limit: int = 2000) -> tuple[list[Movement], bool]:
        """新しい順の履歴と、limit で打ち切ったかどうかを返す。"""
        self.ensure_loaded()
        query = self.col("movements")
        for name, value in (("location_id", location_id), ("product_id", product_id), ("batch_id", batch_id)):
            if value:
                query = query.where(filter=_eq(name, value))
        filtered = any((location_id, product_id, batch_id))
        try:
            from google.cloud import firestore

            docs = list(query.order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit + 1).stream())
        except Exception:
            if not filtered:
                raise
            # 複合インデックスが未作成の場合は、条件だけで全件読んで並べ替える
            docs = list(query.stream())
        items = [m for m in (self._movement(doc) for doc in docs) if m is not None]
        items.sort(key=lambda m: (m.created_at, m.business_date), reverse=True)
        return items[:limit], len(items) > limit

    def has_movements(self, *, location_id: str | None = None, product_id: str | None = None) -> bool:
        query = self.col("movements")
        if location_id:
            query = query.where(filter=_eq("location_id", location_id))
        if product_id:
            query = query.where(filter=_eq("product_id", product_id))
        return any(True for _ in query.limit(1).stream())

    def _batch(self, doc) -> ImportBatch:
        d = doc.to_dict()
        rows = json.loads(zlib.decompress(d["rows_z"]).decode()) if d.get("rows_z") else []
        return ImportBatch(id=doc.id, filename=d["filename"], source=Source(d["source"]), kind=MovementKind(d["kind"]),
                           location=self.location(d.get("location_id")), status=d.get("status", "pending"),
                           zero_missing=d.get("zero_missing", False), date=_d(d.get("date")), rows=rows,
                           warnings=d.get("warnings", []), created_at=_ts(d.get("created_at")))

    def batch(self, batch_id: str) -> ImportBatch | None:
        self.ensure_loaded()
        doc = self.col("import_batches").document(batch_id).get()
        return self._batch(doc) if doc.exists else None

    def batches(self, limit: int = 50) -> list[ImportBatch]:
        from google.cloud import firestore

        self.ensure_loaded()
        docs = self.col("import_batches").order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit)
        return [self._batch(doc) for doc in docs.stream()]


def _eq(name, value):
    from google.cloud.firestore_v1.base_query import FieldFilter

    return FieldFilter(name, "==", value)


store = Store()
