import os
from pathlib import Path

from sqlalchemy import create_engine, event, inspect
from sqlalchemy.orm import DeclarativeBase, sessionmaker

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("STOCK_DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'stock.db'}")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)

if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from . import models  # noqa: F401  (register tables)

    insp = inspect(engine)
    if insp.has_table("products") and "jan" not in {c["name"] for c in insp.get_columns("products")}:
        raise RuntimeError(
            "データベースが旧形式（JANコード対応前）です。"
            f"テストデータのみであれば {DATA_DIR / 'stock.db'} を削除してから再起動してください。"
        )
    Base.metadata.create_all(engine)
    _add_missing_columns()


def _add_missing_columns():
    """後から追加した列を既存の DB に足す（簡易マイグレーション）。"""
    from sqlalchemy import text

    added = {
        "import_batches": {"zero_missing": "BOOLEAN NOT NULL DEFAULT 0", "date": "DATE"},
        "movements": {"date": "DATE"},
        "products": {"brand": "VARCHAR(100) NOT NULL DEFAULT ''", "price": "INTEGER"},
    }
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, cols in added.items():
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in cols.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
