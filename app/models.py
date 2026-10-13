import enum
from datetime import datetime

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


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
    IN = "IN"  # 入庫
    OUT = "OUT"  # 出庫
    SET = "SET"  # 棚卸（数量を上書き）
    TRANSFER_OUT = "TRANSFER_OUT"  # 移動（出）
    TRANSFER_IN = "TRANSFER_IN"  # 移動（入）

    @property
    def label(self) -> str:
        return {
            "IN": "入庫",
            "OUT": "出庫",
            "SET": "棚卸",
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


class Location(Base):
    """拠点（倉庫 / 委託店舗）。地域（日本 / 中国）を持つ。"""

    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    region: Mapped[Region] = mapped_column(Enum(Region))
    type: Mapped[LocationType] = mapped_column(Enum(LocationType))
    note: Mapped[str] = mapped_column(Text, default="")

    @property
    def category_label(self) -> str:
        return f"{self.region.label}・{self.type.label}"


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    unit: Mapped[str] = mapped_column(String(20), default="個")
    note: Mapped[str] = mapped_column(Text, default="")


class Stock(Base):
    __tablename__ = "stocks"
    __table_args__ = (UniqueConstraint("product_id", "location_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id", ondelete="CASCADE"))
    quantity: Mapped[int] = mapped_column(Integer, default=0)

    product: Mapped[Product] = relationship()
    location: Mapped[Location] = relationship()


class ImportBatch(Base):
    """アップロードされたファイルの取込単位。プレビュー → 確定 の2段階で反映する。"""

    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    filename: Mapped[str] = mapped_column(String(255))
    source: Mapped[Source] = mapped_column(Enum(Source))
    kind: Mapped[MovementKind] = mapped_column(Enum(MovementKind))
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending / applied / cancelled
    rows: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)

    location: Mapped[Location | None] = relationship()


class Movement(Base):
    """在庫の増減履歴。"""

    __tablename__ = "movements"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id", ondelete="CASCADE"))
    kind: Mapped[MovementKind] = mapped_column(Enum(MovementKind))
    delta: Mapped[int] = mapped_column(Integer)
    quantity_after: Mapped[int] = mapped_column(Integer)
    source: Mapped[Source] = mapped_column(Enum(Source), default=Source.MANUAL)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("import_batches.id"), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")

    product: Mapped[Product] = relationship()
    location: Mapped[Location] = relationship()
    batch: Mapped[ImportBatch | None] = relationship()
