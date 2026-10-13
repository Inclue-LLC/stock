"""「OZ 納品数集計」Excel を取り込む（初回移行用）。通常は Web 画面の「初期データの取り込み」を使う。

使い方（Firestore の認証情報がある環境で、stock フォルダから実行）:
    .venv/bin/python scripts/import_oz_workbook.py ファイル.xlsx --dry-run   # 確認のみ（保存しない）
    .venv/bin/python scripts/import_oz_workbook.py ファイル.xlsx             # 取り込む
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from openpyxl import load_workbook  # noqa: E402

from app import oz_import  # noqa: E402
from app.store import store  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--dry-run", action="store_true", help="内容を確認するだけで保存しない")
    args = ap.parse_args()
    try:
        result = oz_import.run(store, load_workbook(args.xlsx, data_only=True), dry_run=args.dry_run)
    except ValueError as e:
        sys.exit(str(e))
    print(f"商品: 新規 {result.created}件 / 既存 {result.updated}件")
    for line in result.stores:
        print(line)
    for w in result.warnings:
        print("注意:", w)
    print("取り込みました。" if result.saved else "（--dry-run のため保存していません）")


if __name__ == "__main__":
    main()
