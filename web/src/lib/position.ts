const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function between(lower: string | null | undefined, upper: string | null | undefined): string {
  let a = lower ?? "";
  let b = upper ?? "";
  let result = "";
  let i = 0;
  for (;;) {
    const lowerDigit = i < a.length ? DIGITS.indexOf(a[i]!) : 0;
    const upperDigit = i < b.length ? DIGITS.indexOf(b[i]!) : DIGITS.length - 1;
    if (lowerDigit === upperDigit) {
      result += DIGITS[lowerDigit];
      i++;
      continue;
    }
    if (upperDigit - lowerDigit >= 2) {
      result += DIGITS[lowerDigit + Math.floor((upperDigit - lowerDigit) / 2)];
      return result;
    }
    result += DIGITS[lowerDigit];
    a = a.length > i + 1 ? a.slice(i + 1) : "";
    b = "";
    i = 0;
  }
}

export function after(last: string | null | undefined): string {
  return between(last, null);
}
