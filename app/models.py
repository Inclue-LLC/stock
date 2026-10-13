"""データの型（Firestore に保存する内容）。"""

import datetime as dt
import enum
from dataclasses import dataclass, field
from datetime import date, datetime
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")


def now_jst() -> datetime:
    return datetime.now(JST)


def today_jst() -> date:
    return now_jst().date()


class Region(str, enum.Enum):
    JP = "JP"
    CN = "CN"

    @property
    def label(self) -> str:
        return {"JP": "日本", "CN": "中国"}[self.value]


class LocationType(str, enum.Enum):
    WAREHOUSE = "WAREHOUSE"
    CONSIGNMENT = "CONSIGNMENT"

    @property
    def label(self) -> str:
        return {"WAREHOUSE": "倉庫", "CONSIGNMENT": "委託店舗"}[self.value]


class MovementKind(str, enum.Enum):
    IN = "IN"  # 入庫・納品
    OUT = "OUT"  # 出庫・販売
    SET = "SET"  # 在庫更新（数量を上書き）
    TRANSFER_OUT = "TRANSFER_OUT"  # 移動（出）
    TRANSFER_IN = "TRANSFER_IN"  # 移動（入）

    @property
    def label(self) -> str:
        return {
            "IN": "納品",
            "OUT": "販売",
            "SET": "在庫更新",
            "TRANSFER_OUT": "移動出",
            "TRANSFER_IN": "移動入",
        }[self.value]


class Source(str, enum.Enum):
    MANUAL = "MANUAL"
    EXCEL = "EXCEL"
    CSV = "CSV"
    PDF = "PDF"

    @property
    def label(self) -> str:
        return {"MANUAL": "直接入力", "EXCEL": "Excel", "CSV": "CSV", "PDF": "PDF"}[self.value]


@dataclass
class Location:
    """拠点（倉庫 / 委託店舗）。地域（日本 / 中国）を持つ。"""

    name: str
    region: Region
    type: LocationType
    note: str = ""
    updated_at: datetime | None = None  # 最後に在庫が動いた日時
    id: str | None = None

    @property
    def category_label(self) -> str:
        return f"{self.region.label}・{self.type.label}"


@dataclass
class Product:
    """商品。JAN コードで一意に識別する。JAN のない商品は商品名で識別する（品番は任意の補助コード）。"""

    name: str
    jan: str | None = None
    sku: str = ""
    brand: str = ""
    price: int | None = None  # 上代（税込）
    unit: str = "個"
    note: str = ""
    id: str | None = None


@dataclass
class Stock:
    """商品 × 拠点 の在庫と、店舗別明細用の累計（納品・販売・調整）。"""

    product: Product
    location: Location
    quantity: int = 0
    delivered: int = 0
    sold: int = 0
    adjusted: int = 0  # 在庫更新（上書き）による差分
    deliveries: dict[date, int] = field(default_factory=dict)  # 納品日 → 数量

    @property
    def product_id(self) -> str:
        return self.product.id

    @property
    def location_id(self) -> str:
        return self.location.id

    @property
    def key(self) -> str:
        return f"{self.product.id}_{self.location.id}"


@dataclass
class ImportBatch:
    """アップロードされたファイルの取込単位。プレビュー → 確定 の2段階で反映する。"""

    filename: str
    source: Source
    kind: MovementKind
    location: Location | None = None
    status: str = "pending"  # pending / applied / cancelled
    zero_missing: bool = False  # 在庫更新時、ファイルにない商品を0にする
    date: dt.date | None = None  # 納品日・販売日など（取込時に指定）
    rows: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    created_at: datetime = field(default_factory=now_jst)
    id: str | None = None

    @property
    def location_id(self) -> str | None:
        return self.location.id if self.location else None


@dataclass
class Movement:
    """在庫の増減履歴。"""

    product: Product
    location: Location
    kind: MovementKind
    delta: int
    quantity_after: int
    source: Source = Source.MANUAL
    batch_id: str | None = None
    note: str = ""
    date: dt.date | None = None  # 納品日・販売日など
    created_at: datetime = field(default_factory=now_jst)
    id: str | None = None

    @property
    def product_id(self) -> str:
        return self.product.id

    @property
    def location_id(self) -> str:
        return self.location.id

    @property
    def business_date(self) -> dt.date:
        return self.date or self.created_at.astimezone(JST).date()
