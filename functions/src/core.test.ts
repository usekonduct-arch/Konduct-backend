import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyBachsSignature } from "./bachs/signature";
import { makeVehicleToken, readVehicleToken } from "./domain/qr";
import { canonical, cleanCode, hmacCode, randomCode } from "./lib/crypto";
import { naira, toDecimal, toKobo } from "./lib/money";
import { namesMatch } from "./domain/payouts";
import { decodeCallableData } from "./api/callable";
import { TopUpInput } from "./domain/funding";
import { distanceKm, etaMinutes, roadKm } from "./domain/landmarks";
import { alighted, assertSeats, boarded, countsSeats, liveLoad } from "./domain/seats";
import { RULES } from "./config";

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

test("bus seats: a trip fills, can't overfill, gives seats back on undo and ends on its own", () => {
  const t0 = 1_800_000_000_000;
  const reasonOf = (fn: () => void) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return (e as { details?: { reason?: string } }).details?.reason;
    }
  };
  let load = boarded(null, 3, t0);
  assert.deepEqual(load, { taken: 3, tripStartedAtMs: t0, expiresAtMs: t0 + RULES.seatIdleResetMs });
  load = boarded(liveLoad({ load }, t0 + 60_000), 4, t0 + 60_000);
  assert.equal(load.taken, 7);
  assert.equal(load.tripStartedAtMs, t0); // same trip
  assert.equal(reasonOf(() => assertSeats(7, 6, 1)), "ok");
  assert.equal(reasonOf(() => assertSeats(7, 7, 1)), "bus_full");
  assert.equal(reasonOf(() => assertSeats(7, 5, 3)), "not_enough_seats");
  assert.equal(reasonOf(() => assertSeats(7, 9, 1)), "bus_full"); // seats cut below what's already paid
  // Undo gives seats back on the same trip only.
  assert.equal(alighted(load, 2, t0)?.taken, 5);
  assert.equal(alighted(load, 9, t0)?.taken, 0);
  assert.equal(alighted(load, 2, t0 - 1), null);
  assert.equal(alighted(null, 2, t0), null);
  // Idle too long: the bus counts as empty again.
  assert.equal(liveLoad({ load }, load.expiresAtMs - 1)?.taken, 7);
  assert.equal(liveLoad({ load }, load.expiresAtMs), null);
  assert.equal(liveLoad({ load: { ...load, taken: 0 } }, t0), null);
  assert.equal(liveLoad({}, t0), null);
  // Scans keep a trip alive, but never past tripMaxMs from its first scan.
  let busy = boarded(null, 1, t0);
  for (let at = t0; at < t0 + RULES.tripMaxMs; at += 5 * 60_000) busy = boarded(liveLoad({ load: busy }, at), 0, at);
  assert.equal(busy.expiresAtMs, t0 + RULES.tripMaxMs);
  assert.ok(countsSeats({ type: "shuttle" }) && countsSeats({}) && !countsSeats({ type: "bike" }));
});

test("trip estimates come from the two landmarks' pins", () => {
  const gate = { lat: 7.7553, lng: 4.5476 };
  const shasha = { lat: 7.7743, lng: 4.5476 }; // 0.019° north ≈ 2.11 km
  assert.ok(Math.abs(distanceKm(gate, shasha) - 2.11) < 0.02);
  assert.equal(roadKm(gate, shasha), 2.9); // × 1.35 road factor
  assert.equal(etaMinutes(gate, shasha), 11); // 2.85 km at 20 km/h = 8.6 min, + 2 min of stops, rounded up
  assert.equal(etaMinutes(gate, shasha), etaMinutes(shasha, gate));
  assert.equal(etaMinutes(gate, { lat: 7.7554, lng: 4.5476 }), RULES.minTripMinutes); // next door
});

test("numbers wrapped by the Android Firebase SDK are unwrapped before validation", () => {
  const long = (v: string) => ({ "@type": "type.googleapis.com/google.protobuf.Int64Value", value: v });
  const fromAndroid = { amountKobo: long("200000"), idempotencyKey: "abcdefghijklmnop1234" };
  assert.equal(TopUpInput.safeParse(fromAndroid).success, false); // what Render did before
  const decoded = decodeCallableData(fromAndroid);
  assert.deepEqual(decoded, { amountKobo: 200000, idempotencyKey: "abcdefghijklmnop1234" });
  assert.equal(TopUpInput.safeParse(decoded).success, true);
  // Nested values, arrays, unsigned longs and plain JSON pass through correctly.
  assert.deepEqual(decodeCallableData({ a: [long("1"), { b: long("-2") }], c: "x", d: 3, e: null, f: true }), { a: [1, { b: -2 }], c: "x", d: 3, e: null, f: true });
  assert.equal(decodeCallableData({ "@type": "type.googleapis.com/google.protobuf.UInt64Value", value: "7" }), 7);
  // Anything else carrying "@type" is refused.
  assert.throws(() => decodeCallableData({ "@type": "type.googleapis.com/google.protobuf.Any", value: "1" }));
  assert.throws(() => decodeCallableData({ "@type": "type.googleapis.com/google.protobuf.Int64Value", value: "abc" }));
});

test("push notifications follow the person's language and keep amounts, names and codes", async () => {
  const { translate } = await import("./domain/i18n");
  assert.equal(translate("yo", "₦1,200 added"), "₦1,200 ti wọlé");
  assert.equal(translate("ha", "Low balance"), "Kuɗinku sun yi ƙasa");
  assert.equal(translate("pcm", "₦600 received"), "You don collect ₦600");
  // Parts joined with " · " are translated one by one; the reference stays as it is.
  assert.equal(translate("yo", "3 riders · KD-7Q2MXA"), "Èrò 3 · KD-7Q2MXA");
  assert.equal(translate("ha", "1 rider · KD-7Q2MXA"), "Fasinja 1 · KD-7Q2MXA");
  assert.equal(
    translate("pcm", "You have ₦100 left, not enough for another ₦200 ride. Top up before your next trip."),
    "Na ₦100 remain, e no reach another ₦200 ride. Top up before your next trip.",
  );
  // English, unknown languages and staff-written text come back unchanged.
  assert.equal(translate("en", "₦1,200 added"), "₦1,200 added");
  assert.equal(translate("fr", "₦1,200 added"), "₦1,200 added");
  assert.equal(translate(undefined, "Low balance"), "Low balance");
  assert.equal(translate("yo", "Free rides all day Friday"), "Free rides all day Friday");
});
