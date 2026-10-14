import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 };
export const PIN_ALGO = "scrypt-16384-8-1";

/** 4 or 6 digits (FR-AUTH-06). */
export const isPinShape = (pin: string) => /^(\d{4}|\d{6})$/.test(pin);

/** Same rule as the app (konduct_app pin_screen.dart isWeakPin): no repeats, no runs. */
export function isWeakPin(pin: string): boolean {
  if (new Set(pin).size === 1) return true;
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]);
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

export async function hashPin(pin: string): Promise<{ hash: string; salt: string; algo: string }> {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, 32, PARAMS);
  return { hash: key.toString("base64"), salt: salt.toString("base64"), algo: PIN_ALGO };
}

export async function verifyPin(pin: string, stored: { hash: string; salt: string }): Promise<boolean> {
  const key = await scrypt(pin, Buffer.from(stored.salt, "base64"), 32, PARAMS);
  const want = Buffer.from(stored.hash, "base64");
  return want.length === key.length && timingSafeEqual(want, key);
}
