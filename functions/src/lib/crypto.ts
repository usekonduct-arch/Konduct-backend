import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hmacHex = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest("hex");
export const hmacB64u = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest("base64url");

/** Constant-time string compare that is also safe for unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Crockford base32 without I, L, O, U: easy to read aloud and type. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Uniformly random code from the readable alphabet (crypto RNG). */
export function randomCode(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Deterministic code from an HMAC, for codes the server must be able to recompute. */
export function hmacCode(key: string, msg: string, len: number): string {
  const bytes = createHmac("sha256", key).update(msg).digest();
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

export const randomId = (bytes = 16) => randomBytes(bytes).toString("base64url");

/** Normalise a code a person typed: uppercase, drop spaces/dashes, fix O/I/L lookalikes. */
export const cleanCode = (s: string) =>
  s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

/**
 * Stable JSON for hashing: keys sorted at every level, so the same ledger entry
 * always hashes the same no matter how it was built.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
