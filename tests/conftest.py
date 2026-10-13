"""テストは Firestore エミュレータに対して実行する。

FIRESTORE_EMULATOR_HOST が未設定なら、firebase-tools がダウンロードしたエミュレータ（Java）を自動で起動する。
  （事前に `npx firebase-tools setup:emulators:firestore` を一度実行しておく）
"""

import glob
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

PROJECT = "demo-stock-test"
os.environ["GOOGLE_CLOUD_PROJECT"] = PROJECT


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start_emulator():
    jars = sorted(glob.glob(str(Path.home() / ".cache/firebase/emulators/cloud-firestore-emulator-*.jar")))
    if not jars:
        pytest.exit("Firestore エミュレータが見つかりません。`npx firebase-tools setup:emulators:firestore` を実行してください")
    port = _free_port()
    proc = subprocess.Popen(["java", "-jar", jars[-1], "--host=127.0.0.1", f"--port={port}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    return proc, f"127.0.0.1:{port}"


_proc = None
if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
    _proc, os.environ["FIRESTORE_EMULATOR_HOST"] = _start_emulator()


def pytest_unconfigure(config):
    if _proc:
        _proc.terminate()


from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.store import store  # noqa: E402


def clear_emulator():
    host = os.environ["FIRESTORE_EMULATOR_HOST"]
    req = urllib.request.Request(
        f"http://{host}/emulator/v1/projects/{PROJECT}/databases/(default)/documents", method="DELETE")
    urllib.request.urlopen(req)
    store.reset()


@pytest.fixture
def client():
    clear_emulator()
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
    client.post("/products", data={"jan": "4900000000016", "sku": "A-001", "name": "商品A", "unit": "個"})
    return client
