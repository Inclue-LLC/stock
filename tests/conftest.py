import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["STOCK_DATA_DIR"] = _tmp
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def seeded(client):
    for name, region, typ in [
        ("東京倉庫", "JP", "WAREHOUSE"),
        ("大阪委託店", "JP", "CONSIGNMENT"),
        ("上海倉庫", "CN", "WAREHOUSE"),
        ("北京委託店", "CN", "CONSIGNMENT"),
    ]:
        client.post("/locations", data={"name": name, "region": region, "type": typ})
    client.post("/products", data={"sku": "A-001", "name": "商品A", "unit": "個"})
    return client
