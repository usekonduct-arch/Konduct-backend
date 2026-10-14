import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyBachsSignature } from "./bachs/signature";
import { makeVehicleToken, readVehicleToken } from "./domain/qr";
import { canonical, cleanCode, hmacCode, randomCode } from "./lib/crypto";
import { naira, toDecimal, toKobo } from "./lib/money";
import { namesMatch } from "./domain/payouts";

const sign = (secret: string, ts: number, body: string) => createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

test("money crosses the Bachs boundary exactly, with no floats", () => {
  assert.equal(toKobo("2000.00"), 200000);
  assert.equal(toKobo("0.1"), 10);
  assert.equal(toKobo("19.99"), 1999);
  assert.equal(toKobo("250000"), 25000000);
  assert.equal(toDecimal(200000), "2000.00");
  assert.equal(toDecimal(1999), "19.99");
  assert.equal(toDecimal(5), "0.05");
  for (const bad of ["-1.00", "1.234", "1e5", "NaN", "", " 12,000.00", "0x10"]) assert.throws(() => toKobo(bad), bad);
  assert.throws(() => toDecimal(-1));
  assert.throws(() => toDecimal(1.5));
  assert.equal(naira(20000), "₦200");
  assert.equal(naira(20050), "₦200.50");
});

test("Bachs webhook signatures: genuine, forged, stale, replayed and rotated", () => {
  const body = Buffer.from('{"id":"evt_abc123","type":"collection.succeeded","data":{}}');
  const now = 1_800_000_000;
  const good = sign("whsec_live", now, body.toString());

  assert.deepEqual(verifyBachsSignature(body, { timestamp: String(now), signature: good }, ["whsec_live"], now), { ok: true, timestamp: now });
  assert.equal(verifyBachsSignature(body, { v2: `t=${now},v1=${good}` }, ["whsec_live"], now).ok, true);

  // Wrong secret, tampered body, missing parts.
  assert.equal(verifyBachsSignature(body, { timestamp: String(now), signature: good }, ["whsec_other"], now).ok, false);
  assert.equal(verifyBachsSignature(Buffer.from(body.toString().replace("abc", "abd")), { timestamp: String(now), signature: good }, ["whsec_live"], now).ok, false);
  assert.equal(verifyBachsSignature(body, { timestamp: String(now) }, ["whsec_live"], now).ok, false);
  assert.equal(verifyBachsSignature(body, { timestamp: String(now), signature: good }, [], now).ok, false);
  // Signature valid for a different timestamp cannot be re-used with a fresh one.
  assert.equal(verifyBachsSignature(body, { timestamp: String(now + 10), signature: good }, ["whsec_live"], now + 10).ok, false);
  // Replay of a genuine delivery after the 5-minute window.
  assert.deepEqual(verifyBachsSignature(body, { timestamp: String(now), signature: good }, ["whsec_live"], now + 301), { ok: false, why: "stale" });
  // Rotation: two v1 values, our new secret matches the second.
  const fresh = sign("whsec_new", now, body.toString());
  assert.equal(verifyBachsSignature(body, { v2: `t=${now},v1=${good},v1=${fresh}` }, ["whsec_new"], now).ok, true);
  assert.equal(verifyBachsSignature(body, { v2: `t=${now},v1=${good}` }, ["whsec_new", "whsec_live"], now).ok, true);
});

test("vehicle QR tokens can't be forged, altered or moved to another vehicle", () => {
  const key = "qr-key-for-tests";
  const t = makeVehicleToken(key, "veh12345abc", 3);
  assert.deepEqual(readVehicleToken(key, t), { vehicleId: "veh12345abc", version: 3 });
  assert.equal(readVehicleToken("another-key", t), null);
  assert.equal(readVehicleToken(key, t.replace("veh12345abc", "veh12345abd")), null);
  assert.equal(readVehicleToken(key, t.replace(".3.", ".4.")), null);
  assert.equal(readVehicleToken(key, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A")), null);
  assert.equal(readVehicleToken(key, "K1.veh12345abc.3"), null);
  assert.equal(readVehicleToken(key, "x".repeat(500)), null);
  assert.ok(!t.includes("₦") && !/\d{10}/.test(t), "no money or account numbers in the payload");
});

test("codes are readable, deterministic where needed, and forgiving to type", () => {
  assert.match(randomCode(8), /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(hmacCode("k", "fare_1", 6), hmacCode("k", "fare_1", 6));
  assert.notEqual(hmacCode("k", "fare_1", 6), hmacCode("k", "fare_2", 6));
  assert.equal(cleanCode(" k7q-2mx "), "K7Q2MX");
  assert.equal(cleanCode("kdO1Il"), "KD0111");
});

test("canonical JSON is key-order independent (stable ledger hashes)", () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), canonical({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
});

test("bank account name must match the verified driver (FR-DRV-06)", () => {
  assert.ok(namesMatch("Tunde Adebayo", "ADEBAYO TUNDE"));
  assert.ok(namesMatch("Tunde Adebayo", "ADEBAYO TUNDE OLUWASEUN"));
  assert.ok(namesMatch("Tunde Kola Adebayo", "MR. ADEBAYO, TUNDE"));
  assert.ok(!namesMatch("Tunde Adebayo", "TUNDE OKAFOR"));
  assert.ok(!namesMatch("Tunde Adebayo", "KONDUCT PAYOUTS LTD"));
  assert.ok(!namesMatch("Tunde Adebayo", ""));
});
