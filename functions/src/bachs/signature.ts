import { hmacHex, safeEqual } from "../lib/crypto";

/** Bachs allows 5 minutes either side; older deliveries are treated as replays. */
export const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Verifies a Bachs webhook (https://docs.bachs.io/guides/webhooks/overview).
 * HMAC-SHA256 hex of "{timestamp}.{raw body}" with the endpoint's signing secret.
 * Prefers X-Bachs-Signature-V2 ("t=..,v1=..,v1=..") so a secret rotation keeps verifying;
 * falls back to X-Bachs-Timestamp + X-Bachs-Signature. Any of our secrets may match.
 */
export function verifyBachsSignature(
  rawBody: Buffer,
  headers: { v2?: string | null; timestamp?: string | null; signature?: string | null },
  secrets: string[],
  nowSec = Math.floor(Date.now() / 1000),
): { ok: true; timestamp: number } | { ok: false; why: string } {
  const keys = secrets.map((s) => s.trim()).filter(Boolean);
  if (!keys.length) return { ok: false, why: "no secret configured" };

  let ts: number;
  let candidates: string[];
  if (headers.v2) {
    const parts = headers.v2.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
    ts = Number(parts.find(([k]) => k === "t")?.[1]);
    candidates = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v);
  } else {
    ts = Number(headers.timestamp);
    candidates = headers.signature ? [headers.signature.trim()] : [];
  }
  if (!Number.isInteger(ts) || ts <= 0) return { ok: false, why: "bad timestamp" };
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) return { ok: false, why: "stale" };
  if (!candidates.length) return { ok: false, why: "no signature" };

  const message = `${ts}.${rawBody.toString("utf8")}`;
  for (const key of keys) {
    const expected = hmacHex(key, message);
    if (candidates.some((c) => safeEqual(expected, c.toLowerCase()))) return { ok: true, timestamp: ts };
  }
  return { ok: false, why: "mismatch" };
}
