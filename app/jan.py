"""JAN コード（EAN-13 / EAN-8）の正規化とチェックデジット検証。"""

import re
import unicodedata


class JanError(ValueError):
    pass


def check_digit(body: str) -> int:
    """チェックデジットを除いた数字列から、チェックデジットを計算する。"""
    total = 0
    for i, ch in enumerate(reversed(body)):
        total += int(ch) * (3 if i % 2 == 0 else 1)
    return (10 - total % 10) % 10


def is_valid(code: str) -> bool:
    return bool(re.fullmatch(r"\d{8}|\d{13}", code)) and check_digit(code[:-1]) == int(code[-1])


def normalize(value) -> str:
    """Excel の数値・全角数字・ハイフン入りなどを 8 / 13 桁の JAN に揃える。不正なら JanError。"""
    if value is None or value == "":
        raise JanError("JANコードが空です")
    if isinstance(value, bool):
        raise JanError("JANコードが不正です")
    if isinstance(value, float):
        if not value.is_integer():
            raise JanError(f"JANコード「{value}」が不正です")
        value = int(value)
    s = unicodedata.normalize("NFKC", str(value)).strip()
    if re.fullmatch(r"\d(\.\d+)?e\+\d+", s, re.IGNORECASE):
        raise JanError(f"JANコード「{s}」が指数表記になっています。Excel で列を文字列にして保存してください")
    s = re.sub(r"[\s\-]", "", s)
    if not s.isdigit():
        raise JanError(f"JANコード「{s}」に数字以外が含まれています")
    # Excel で先頭の 0 が落ちた 12 桁 / 7 桁を補う
    if len(s) in (7, 12) and is_valid("0" + s):
        s = "0" + s
    if len(s) not in (8, 13):
        raise JanError(f"JANコード「{s}」は8桁または13桁ではありません")
    if not is_valid(s):
        raise JanError(f"JANコード「{s}」のチェックデジットが正しくありません")
    return s


def try_normalize(value) -> tuple[str | None, str | None]:
    try:
        return normalize(value), None
    except JanError as e:
        return None, str(e)
