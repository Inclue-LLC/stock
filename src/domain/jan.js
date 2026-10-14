// JAN コード（EAN-13 / EAN-8）の正規化とチェックデジット検証。

export class JanError extends Error {}

/** チェックデジットを除いた数字列から、チェックデジットを計算する。 */
export function checkDigit(body) {
  let total = 0;
  [...body].reverse().forEach((ch, i) => {
    total += Number(ch) * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (total % 10)) % 10;
}

export function isValid(code) {
  return /^(\d{8}|\d{13})$/.test(code || "") && checkDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

/** Excel の数値・全角数字・ハイフン入りなどを 8 / 13 桁の JAN に揃える。不正なら JanError。 */
export function normalize(value) {
  if (value === null || value === undefined || value === "") throw new JanError("JANコードが空です");
  if (typeof value === "boolean") throw new JanError("JANコードが不正です");
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new JanError(`JANコード「${value}」が不正です`);
    value = BigInt(value).toString();
  }
  let s = String(value).normalize("NFKC").trim();
  if (/^\d(\.\d+)?e\+\d+$/i.test(s)) {
    throw new JanError(`JANコード「${s}」が指数表記になっています。Excel で列を文字列にして保存してください`);
  }
  s = s.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(s)) throw new JanError(`JANコード「${s}」に数字以外が含まれています`);
  // Excel で先頭の 0 が落ちた 12 桁 / 7 桁を補う
  if ((s.length === 7 || s.length === 12) && isValid("0" + s)) s = "0" + s;
  if (s.length !== 8 && s.length !== 13) throw new JanError(`JANコード「${s}」は8桁または13桁ではありません`);
  if (!isValid(s)) throw new JanError(`JANコード「${s}」のチェックデジットが正しくありません`);
  return s;
}

/** [正規化済み JAN, エラー文] を返す。 */
export function tryNormalize(value) {
  try {
    return [normalize(value), null];
  } catch (e) {
    if (e instanceof JanError) return [null, e.message];
    throw e;
  }
}
