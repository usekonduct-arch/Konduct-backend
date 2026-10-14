/**
 * Money is integer kobo everywhere inside Konduct (SRS 5). Bachs speaks decimal strings
 * ("2000.00"). These two functions are the only crossing point, and neither touches floats.
 */

const DECIMAL = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/** "2000.00" -> 200000. Throws on anything that is not a plain non-negative decimal. */
export function toKobo(amount: string): number {
  const m = DECIMAL.exec(String(amount).trim());
  if (!m) throw new Error(`not a money amount: ${JSON.stringify(amount)}`);
  const kobo = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(kobo)) throw new Error("amount out of range");
  return kobo;
}

/** 200000 -> "2000.00" */
export function toDecimal(kobo: number): string {
  if (!Number.isSafeInteger(kobo) || kobo < 0) throw new Error(`bad kobo: ${kobo}`);
  return `${Math.floor(kobo / 100)}.${String(kobo % 100).padStart(2, "0")}`;
}

/** ₦2,000 / ₦2,000.50 for messages. */
export function naira(kobo: number): string {
  const whole = Math.floor(Math.abs(kobo) / 100).toLocaleString("en-NG");
  const frac = Math.abs(kobo) % 100;
  return `${kobo < 0 ? "-" : ""}₦${whole}${frac ? "." + String(frac).padStart(2, "0") : ""}`;
}

export const isKobo = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
