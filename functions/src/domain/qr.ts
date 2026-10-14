/**
 * Vehicle QR tokens (SEC-QR-01, FR-PAY-01, FR-DRV-08).
 *
 *   K1.<vehicleId>.<tokenVersion>.<signature>
 *
 * Opaque, signed by the server, no money or personal data. Re-issuing a sticker bumps
 * tokenVersion on the vehicle, so every older sticker stops working at once.
 */
import { hmacB64u, safeEqual } from "../lib/crypto";

const PREFIX = "K1";
const SIG_LEN = 22; // 132 bits of HMAC-SHA256, base64url

const sign = (key: string, vehicleId: string, version: number) => hmacB64u(key, `${PREFIX}|${vehicleId}|${version}`).slice(0, SIG_LEN);

export function makeVehicleToken(key: string, vehicleId: string, version: number): string {
  if (!/^[A-Za-z0-9]{8,40}$/.test(vehicleId) || !Number.isInteger(version) || version < 1) throw new Error("bad vehicle token input");
  return `${PREFIX}.${vehicleId}.${version}.${sign(key, vehicleId, version)}`;
}

/** Returns the vehicle and version only when the signature is genuine. */
export function readVehicleToken(key: string, token: string): { vehicleId: string; version: number } | null {
  if (typeof token !== "string" || token.length > 120) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, vehicleId, v, sig] = parts;
  const version = Number(v);
  if (!/^[A-Za-z0-9]{8,40}$/.test(vehicleId) || !Number.isInteger(version) || version < 1 || sig.length !== SIG_LEN) return null;
  return safeEqual(sign(key, vehicleId, version), sig) ? { vehicleId, version } : null;
}
