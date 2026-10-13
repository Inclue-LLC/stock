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
    _allow_null_jan()


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


def _allow_null_jan():
    """products.jan を NULL 可にする（JAN なし商品の登録に対応。SQLite は列定義を変えられないので作り直す）。"""
    if not DATABASE_URL.startswith("sqlite"):
        return
    from .models import Product

    raw = engine.raw_connection()
    try:
        cur = raw.cursor()
        row = cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").fetchone()
        if not row or "jan VARCHAR(13) NOT NULL" not in row[0]:
            return
        ddl = row[0]
        cols = ", ".join(r[1] for r in cur.execute("PRAGMA table_info(products)").fetchall())
        raw.commit()
        cur.execute("PRAGMA foreign_keys=OFF")
        try:
            cur.execute("BEGIN")
            cur.execute(ddl.replace("CREATE TABLE products", "CREATE TABLE products_new", 1)
                        .replace("jan VARCHAR(13) NOT NULL", "jan VARCHAR(13)"))
            cur.execute(f"INSERT INTO products_new ({cols}) SELECT {cols} FROM products")
            cur.execute("DROP TABLE products")
            cur.execute("ALTER TABLE products_new RENAME TO products")
            raw.commit()
        except Exception:
            raw.rollback()
            raise
        finally:
            cur.execute("PRAGMA foreign_keys=ON")
    finally:
        raw.close()
    for index in Product.__table__.indexes:
        index.create(engine, checkfirst=True)
