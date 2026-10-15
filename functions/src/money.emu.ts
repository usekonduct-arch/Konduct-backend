/**
 * Attack and integrity tests for the money paths, against the Firestore + Auth emulators
 * (SRS 9.3: concurrency, idempotency, replay, token tampering, failure handling).
 */
import { actorFor, balance, bachsCalls, keyOf, makeDriverWithVehicle, makeRider, onBachs, resetBachs, setPin, uniq, webhook } from "./test/harness";

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { CAMPUS_ID } from "./config";
import { studentIdKey } from "./identity";
import { auth, db, stamp } from "./lib/db";
import { isHttpsError } from "./lib/errors";
import { driverAccount, PLATFORM, riderAccount, verifyAccount } from "./ledger/ledger";
import { confirmPayment, previewPayment } from "./domain/pay";
import { createTopUp, reconcileTopUps, refreshTopUps } from "./domain/funding";
import { lookUpReceipt, receiptProof } from "./domain/receipts";
import { deleteAd, sendNotice, uploadMedia, upsertAd } from "./domain/messaging";
import { handleBachsWebhook } from "./bachs/webhook";
import { setVehicleStatus, setUserStatus, issueVehicleQr, inviteDriver, resetDriverCode, requestAdjustment, requestKycTier, UpdateUser, updateUserDetails } from "./domain/staff";
import { addStaff, markPasswordChosen, resetStaffPassword, revokeStaff, setStaffRole } from "./domain/team";
import { claimDriverAccount } from "./domain/accounts";
import { memberToken } from "./lib/guards";
import { decide } from "./domain/approvals";
import { onPayoutEvent, payoutDriver, requestRiderWithdrawal, setPayoutAccount } from "./domain/payouts";
import { openDispute, resolveDispute, reviewDispute } from "./domain/disputes";
import { reconcile } from "./domain/recon";
import { fleetRef, readFleet, setFleet, startNewTrip } from "./domain/seats";
import { rebuildBoard, refreshBoard, setVehiclePark } from "./domain/board";
import { setParkBuses, upsertPark } from "./domain/parks";
import { setVehicleRoute, upsertLandmark } from "./domain/landmarks";
import { rateDriver } from "./domain/ratings";
import { openSupport, replySupport, sendSupport, setSupportStatus } from "./domain/support";

const evtId = () => `evt_${uniq("e")}`;

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (isHttpsError(e)) return (e.details as { reason: string }).reason;
    throw e;
  }
};

const pay = async (rider: Awaited<ReturnType<typeof makeRider>>, token: string, opts: { passengers?: number; key?: string; repeat?: boolean; pin?: string } = {}) => {
  const q = await previewPayment(rider.actor, { qr: token, passengers: opts.passengers ?? 1 });
  return confirmPayment(rider.actor, { quoteId: q.quoteId, idempotencyKey: opts.key ?? keyOf(), repeatConfirmed: opts.repeat ?? true, pin: opts.pin });
};

beforeEach(() => resetBachs());

describe("scan to pay", () => {
  test("a payment moves exactly the quoted fare and writes a verifiable ledger", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    await setPin(r.uid, "2580");
    const preview = await previewPayment(r.actor, { qr: d.token, passengers: 3 });
    assert.equal(preview.totalKobo, 60_000);
    assert.equal(preview.driverFirstName, "Tunde");
    assert.equal(preview.needsPin, true);
    const out = await confirmPayment(r.actor, { quoteId: preview.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false, pin: "2580" });
    assert.equal(out.balanceKobo, 40_000);
    assert.equal(await balance(riderAccount(r.uid)), 40_000);
    assert.equal(await balance(driverAccount(d.uid)), 60_000);
    assert.equal(out.rideTokens.length, 3);
    const trips = await db.collection("trips").where("txId", "==", out.txId).get();
    assert.equal(trips.size, 3);
    const feed = await db.doc(`driverFeed/${d.uid}/items/${out.txId}`).get();
    assert.equal(feed.get("riders"), 3);
    assert.deepEqual((await verifyAccount(riderAccount(r.uid))).ok, true);
    assert.deepEqual((await verifyAccount(driverAccount(d.uid))).ok, true);
  });

  test("the same idempotency key never debits twice", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    const key = keyOf();
    const [a, b] = await Promise.all([
      confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: key, repeatConfirmed: false }),
      confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: key, repeatConfirmed: false }).catch((e) => e),
    ]);
    const c = await confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: key, repeatConfirmed: false });
    assert.equal(c.txId, a.txId);
    if (!(b instanceof Error)) assert.equal(b.txId, a.txId);
    assert.equal(await balance(riderAccount(r.uid)), 80_000);
  });

  test("a quote is single-use: a new key can't replay it (SEC-QR-05)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    await confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false });
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "quote_used");
  });

  test("someone else's quote can't be spent (BOLA)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const victim = await makeRider(100_000);
    const thief = await makeRider(100_000);
    const q = await previewPayment(victim.actor, { qr: d.token, passengers: 1 });
    assert.equal(await reason(confirmPayment(thief.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "quote_missing");
    assert.equal(await balance(riderAccount(victim.uid)), 100_000);
  });

  test("parallel scans can never overdraw a wallet", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000); // room for exactly 5
    const quotes = [];
    for (let i = 0; i < 8; i++) quotes.push(await previewPayment(r.actor, { qr: d.token, passengers: 1 }));
    const results = await Promise.allSettled(quotes.map((q) => confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true })));
    const ok = results.filter((x) => x.status === "fulfilled").length;
    assert.equal(ok, 5);
    assert.equal(await balance(riderAccount(r.uid)), 0);
    assert.equal(await balance(driverAccount(d.uid)), 100_000);
    for (const x of results) if (x.status === "rejected") assert.ok(isHttpsError(x.reason) && ["insufficient_funds"].includes((x.reason.details as any).reason));
    assert.equal((await verifyAccount(riderAccount(r.uid))).ok, true);
  });

  test("insufficient balance never partially debits and offers the top-up path", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(30_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 2 });
    assert.equal(q.insufficient, true);
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "insufficient_funds");
    assert.equal(await balance(riderAccount(r.uid)), 30_000);
  });

  test("a second scan of the same vehicle must be acknowledged (FR-GRP-02)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    await pay(r, d.token, { repeat: false });
    const q2 = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    assert.equal(q2.recentlyPaidThisVehicle, true);
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q2.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "repeat_scan");
    await confirmPayment(r.actor, { quoteId: q2.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true });
    assert.equal(await balance(riderAccount(r.uid)), 60_000);
  });

  test("forged, altered and replaced stickers are refused before any debit", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    assert.equal(await reason(previewPayment(r.actor, { qr: d.token.slice(0, -2) + "AA", passengers: 1 })), "bad_code");
    assert.equal(await reason(previewPayment(r.actor, { qr: "K1.someothervehicle.1.AAAAAAAAAAAAAAAAAAAAAA", passengers: 1 })), "bad_code");
    const staff = actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });
    const reissued = await issueVehicleQr(staff, d.vehicleId);
    assert.equal(await reason(previewPayment(r.actor, { qr: d.token, passengers: 1 })), "sticker_revoked");
    const ok = await previewPayment(r.actor, { qr: reissued.token, passengers: 1 });
    assert.equal(ok.stickerChangedRecently, true);
  });

  test("a quote dies if the sticker is replaced between preview and confirm", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    await issueVehicleQr(actorFor(uniq("adm"), "admin", { role: "admin", status: "active" }), d.vehicleId);
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "vehicle_changed");
    assert.equal(await balance(riderAccount(r.uid)), 100_000);
  });

  test("a fare change between preview and confirm is refused (FR-PAY-09)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    await db.doc(`routes/${d.routeId}`).update({ fareKobo: 30_000, fareVersion: 2 });
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "fare_changed");
  });

  test("a suspended rider or driver can't pay or be paid, instantly (FR-ADM-02)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    const staff = actorFor(uniq("sup"), "support", { role: "support", status: "active" });
    await setUserStatus(staff, r.uid, "suspended", "lost phone");
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "account_locked");
    const r2 = await makeRider(100_000);
    const q2 = await previewPayment(r2.actor, { qr: d.token, passengers: 1 });
    await setUserStatus(staff, d.uid, "suspended", "investigation");
    assert.equal(await reason(confirmPayment(r2.actor, { quoteId: q2.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "driver_inactive");
  });

  test("big payments need the right PIN, and 5 wrong tries lock it", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(500_000);
    await setPin(r.uid, "2580");
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 3 }); // ₦600 >= ₦500
    assert.equal(q.needsPin, true);
    const attempt = (pin?: string) => confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true, pin });
    assert.equal(await reason(attempt()), "pin_required");
    for (let i = 0; i < 4; i++) assert.equal(await reason(attempt("1397")), "pin_wrong");
    assert.equal(await reason(attempt("1397")), "pin_locked");
    assert.equal(await reason(attempt("2580")), "pin_locked"); // even the right PIN, until the lock lapses
    assert.equal(await balance(riderAccount(r.uid)), 500_000);
  });

  test("daily spend limits count group payments in full (FR-GRP-06)", async () => {
    const d = await makeDriverWithVehicle(300_000); // ₦3,000 fare: tier-1 daily cap is ₦10,000
    const r = await makeRider(2_000_000);
    await setPin(r.uid, "2580");
    await pay(r, d.token, { passengers: 1, pin: "2580" });
    await pay(r, d.token, { passengers: 1, pin: "2580" });
    await pay(r, d.token, { passengers: 1, pin: "2580" });
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true, pin: "2580" })), "over_daily_limit");
  });

  test("a fare can't be undone by the rider: old apps get an undo time that has already passed", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const before = Date.now();
    const out = await pay(r, d.token);
    assert.ok(out.undoUntilMs <= Date.now() && out.undoUntilMs >= before);
    assert.equal((await db.doc(`transactions/${out.txId}`).get()).get("undoUntilMs"), undefined);
    assert.equal(await balance(riderAccount(r.uid)), 80_000);
    assert.equal(await balance(driverAccount(d.uid)), 20_000);
  });
});

describe("bus seats by scan", () => {
  const admin = () => actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });
  const seatsOf = async (vehicleId: string) => ((await db.doc(`vehicles/${vehicleId}`).get()).get("load")?.taken as number) ?? 0;

  test("a bus sells at most its seats; the next scan is refused before any debit", async () => {
    const d = await makeDriverWithVehicle(5_000); // ₦50: even a full bus stays under the PIN threshold
    const a = await makeRider(100_000);
    const b = await makeRider(100_000);
    const c = await makeRider(100_000);
    const first = await previewPayment(a.actor, { qr: d.token, passengers: 1 });
    assert.equal(first.seatCapacity, 7);
    assert.equal(first.seatsTaken, 0);
    await pay(a, d.token, { passengers: 3 });
    await pay(b, d.token, { passengers: 2 });
    const q = await previewPayment(c.actor, { qr: d.token, passengers: 1 });
    assert.equal(q.seatsTaken, 5);
    assert.equal(await reason(previewPayment(c.actor, { qr: d.token, passengers: 3 })), "not_enough_seats");
    await pay(c, d.token, { passengers: 2 });
    assert.equal(await seatsOf(d.vehicleId), 7);
    const late = await makeRider(100_000);
    assert.equal(await reason(previewPayment(late.actor, { qr: d.token, passengers: 1 })), "bus_full");
    assert.equal(await balance(riderAccount(late.uid)), 100_000);
    assert.equal(await balance(driverAccount(d.uid)), 35_000);
  });

  test("parallel scans can't oversell a bus: the transaction re-checks the seats", async () => {
    const d = await makeDriverWithVehicle(5_000);
    const riders = await Promise.all(Array.from({ length: 5 }, () => makeRider(100_000)));
    // Every rider previews an empty bus first, then all pay at once: 5 groups of 2 for 7 seats.
    const quotes = await Promise.all(riders.map((r) => previewPayment(r.actor, { qr: d.token, passengers: 2 })));
    const results = await Promise.allSettled(quotes.map((q, i) => confirmPayment(riders[i].actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true })));
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 3);
    for (const x of results) if (x.status === "rejected") assert.ok(["bus_full", "not_enough_seats"].includes((x.reason.details as any).reason));
    assert.equal(await seatsOf(d.vehicleId), 6);
    assert.equal(await balance(driverAccount(d.uid)), 30_000);
  });

  test("the driver's New trip clears the bus", async () => {
    const d = await makeDriverWithVehicle(5_000);
    const a = await makeRider(100_000);
    const b = await makeRider(100_000);
    await pay(a, d.token, { passengers: 4 });
    await pay(b, d.token, { passengers: 3 });
    assert.equal(await seatsOf(d.vehicleId), 7);
    await startNewTrip(d.actor);
    assert.equal(await seatsOf(d.vehicleId), 0);
    const q = await previewPayment(a.actor, { qr: d.token, passengers: 6 });
    assert.equal(q.seatsTaken, 0);
    // Another driver can't clear this bus.
    const other = await makeDriverWithVehicle(5_000);
    assert.equal(await reason(startNewTrip({ ...other.actor, user: { ...other.actor.user, vehicleId: d.vehicleId } })), "not_your_vehicle");
  });

  test("a trip nobody has scanned into for a while counts as an empty bus", async () => {
    const d = await makeDriverWithVehicle(5_000);
    const a = await makeRider(100_000);
    await pay(a, d.token, { passengers: 6 });
    await db.doc(`vehicles/${d.vehicleId}`).update({ "load.expiresAtMs": Date.now() - 1 });
    const q = await previewPayment(a.actor, { qr: d.token, passengers: 5 });
    assert.equal(q.seatsTaken, 0);
    await confirmPayment(a.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true });
    assert.equal(await seatsOf(d.vehicleId), 5);
  });

  test("the admin's seat count applies to every bus; bikes aren't counted", async () => {
    const d = await makeDriverWithVehicle(5_000);
    const a = await makeRider(100_000);
    await setFleet(admin(), { busSeats: 4 });
    try {
      assert.equal((await previewPayment(a.actor, { qr: d.token, passengers: 1 })).seatCapacity, 4);
      assert.equal(await reason(previewPayment(a.actor, { qr: d.token, passengers: 5 })), "too_many");
      await pay(a, d.token, { passengers: 4 });
      assert.equal(await reason(previewPayment(a.actor, { qr: d.token, passengers: 1 })), "bus_full");
    } finally {
      await setFleet(admin(), { busSeats: 7 });
    }
    const bike = await makeDriverWithVehicle(5_000);
    await db.doc(`vehicles/${bike.vehicleId}`).update({ type: "bike", capacity: 1 });
    const q = await previewPayment(a.actor, { qr: bike.token, passengers: 1 });
    assert.equal(q.seatCapacity, null);
    await pay(a, bike.token);
    await pay(a, bike.token);
    assert.equal(await seatsOf(bike.vehicleId), 0);
  });
});

describe("parks", () => {
  test("staff add a park, then keep its bus count, which never goes below zero", async () => {
    const ops = actorFor(uniq("ops"), "ops", { role: "ops", status: "active" });
    const marshal = actorFor(uniq("msh"), "marshal", { role: "marshal", status: "active" });
    const parkId = uniq("park").toLowerCase();
    const made = await upsertPark(ops, { parkId, name: "Shasha park", location: "Shasha junction, Osogbo", lat: 7.77, lng: 4.55, active: true });
    assert.equal(made.created, true);
    assert.equal((await db.doc(`parks/${parkId}`).get()).get("busCount"), 0);
    assert.equal((await setParkBuses(marshal, { parkId, change: 1 })).busCount, 1);
    assert.equal((await setParkBuses(marshal, { parkId, count: 6 })).busCount, 6);
    assert.equal((await setParkBuses(marshal, { parkId, change: -1 })).busCount, 5);
    assert.equal((await setParkBuses(marshal, { parkId, change: -20 })).busCount, 0);
    const p = await db.doc(`parks/${parkId}`).get();
    assert.equal(p.get("busCountBy"), marshal.uid);
    assert.ok(Date.now() - p.get("busCountAtMs") < 60_000);
    // Editing the park keeps its count.
    await setParkBuses(marshal, { parkId, count: 3 });
    assert.equal((await upsertPark(ops, { parkId, name: "Shasha motor park", location: "Shasha junction", lat: null, lng: null, active: true })).created, false);
    assert.equal((await db.doc(`parks/${parkId}`).get()).get("busCount"), 3);
    assert.equal(await reason(setParkBuses(marshal, { parkId: "no-such-park", change: 1 })), "no_park");
  });
});

describe("trip routes and ratings", () => {
  const admin = actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });
  const marshal = actorFor(uniq("msh"), "marshal", { role: "marshal", status: "active" });
  const place = async (name: string, lat: number, lng: number) => {
    const landmarkId = uniq("lm").toLowerCase();
    await upsertLandmark(admin, { landmarkId, name, lat, lng, active: true });
    return landmarkId;
  };

  test("the driver picks a route between landmarks; a new trip clears the seats; staff can change it", async () => {
    const gate = await place("Main gate", 7.7553, 4.5476);
    const shasha = await place("Shasha park", 7.7743, 4.5476);
    const d = await makeDriverWithVehicle(5_000);
    const r = await makeRider(100_000);
    const route = await setVehicleRoute(d.actor, d.vehicleId, { fromId: shasha, toId: gate, newTrip: true });
    assert.equal(route.etaMin, 11);
    assert.equal(route.fromName, "Shasha park");
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    assert.deepEqual(q.tripRoute, { from: "Shasha park", to: "Main gate", etaMin: 11 });
    await confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true });
    const vehicle = async () => (await db.doc(`vehicles/${d.vehicleId}`).get()).data()!;
    assert.equal((await vehicle()).load.taken, 1);

    // Staff help: the route changes, the riders on board stay counted.
    await setVehicleRoute(marshal, d.vehicleId, { fromId: gate, toId: shasha, newTrip: false });
    assert.equal((await vehicle()).currentRoute.setByStaff, true);
    assert.equal((await vehicle()).load.taken, 1);
    // The driver's new trip, on the way back, starts with an empty bus.
    await setVehicleRoute(d.actor, d.vehicleId, { fromId: shasha, toId: gate, newTrip: true });
    assert.equal((await vehicle()).load, undefined);

    const other = await makeDriverWithVehicle(5_000);
    assert.equal(await reason(setVehicleRoute(other.actor, d.vehicleId, { fromId: gate, toId: shasha, newTrip: false })), "not_your_vehicle");
    assert.equal(await reason(setVehicleRoute(d.actor, d.vehicleId, { fromId: gate, toId: "no-such-place", newTrip: false })), "no_landmark");
  });

  test("a rider rates the driver once, after the estimated arrival, and the driver sees only the average", async () => {
    const a = await place("Senate", 7.7553, 4.5476);
    const b = await place("Hostel", 7.7743, 4.5476);
    const d = await makeDriverWithVehicle(5_000);
    await setVehicleRoute(d.actor, d.vehicleId, { fromId: a, toId: b, newTrip: true });
    const r = await makeRider(100_000);
    const out = await pay(r, d.token);
    const t = await db.doc(`transactions/${out.txId}`).get();
    assert.ok(Math.abs(t.get("rateFromMs") - (t.get("createdAtMs") + 11 * 60_000)) < 1000);
    assert.equal(t.get("driverFirstName"), "Tunde");
    assert.equal(await reason(rateDriver(r.actor, { txId: out.txId, stars: 5, comment: "" })), "too_early");

    await t.ref.update({ rateFromMs: Date.now() - 1 }); // the trip is over
    const stranger = await makeRider(0);
    assert.equal(await reason(rateDriver(stranger.actor, { txId: out.txId, stars: 1, comment: "" })), "bad_tx");
    await rateDriver(r.actor, { txId: out.txId, stars: 4, comment: "Smooth ride" });
    assert.equal(await reason(rateDriver(r.actor, { txId: out.txId, stars: 1, comment: "" })), "already_rated");
    const driver = await db.doc(`users/${d.uid}`).get();
    assert.equal(driver.get("ratingSum"), 4);
    assert.equal(driver.get("ratingCount"), 1);
    assert.equal((await db.doc(`ratings/${out.txId}`).get()).get("comment"), "Smooth ride");

    // A refunded payment can't be rated.
    const undone = await pay(r, d.token);
    await db.doc(`transactions/${undone.txId}`).update({ status: "refunded", rateFromMs: Date.now() - 1 });
    assert.equal(await reason(rateDriver(r.actor, { txId: undone.txId, stars: 5, comment: "" })), "not_rateable");
  });
});

describe("support chat", () => {
  test("a rider opens a conversation, staff reply and close it, writing again reopens it", async () => {
    const r = await makeRider(0);
    const staff = actorFor(uniq("sup"), "support", { role: "support", status: "active", fullName: "Bisi Ade" });
    const { threadId } = await openSupport(r.actor, { category: "complaint", message: "The driver was rude to us at Shasha park." });
    const thread = () => db.doc(`supportThreads/${threadId}`).get();
    assert.equal((await thread()).get("uid"), r.uid);
    assert.equal((await thread()).get("lastFrom"), "member");

    await replySupport(staff, { threadId, text: "Sorry about that. Which bus was it?", close: false });
    assert.equal((await thread()).get("lastFrom"), "staff");
    const msgs = await db.collection(`supportThreads/${threadId}/messages`).orderBy("atMs").get();
    assert.deepEqual(msgs.docs.map((d) => d.get("from")), ["member", "staff"]);
    assert.equal(msgs.docs[1].get("authorName"), "Bisi");
    const pushes = await db.collection(`users/${r.uid}/notifications`).where("kind", "==", "support.reply").get();
    assert.equal(pushes.size, 1);

    await setSupportStatus(staff, { threadId, status: "closed" });
    await sendSupport(r.actor, { threadId, text: "It was OS 482 KJA." });
    assert.equal((await thread()).get("status"), "open");
    assert.equal((await thread()).get("messageCount"), 3);

    const other = await makeRider(0);
    assert.equal(await reason(sendSupport(other.actor, { threadId, text: "hello" })), "no_thread");
    assert.equal(await reason(openSupport(other.actor, { category: "payment", message: "This one", txId: "fare_notmine12345" })), "bad_tx");
  });

  test("one person can't flood support with open conversations", async () => {
    const d = await makeDriverWithVehicle(5_000);
    for (let i = 0; i < 3; i++) await openSupport(d.actor, { category: "app", message: `Problem ${i}` });
    assert.equal(await reason(openSupport(d.actor, { category: "app", message: "Another" })), "too_many_open");
  });
});

describe("funding via Bachs", () => {
  const paidCheckout = (topupId: string, amount = "2000.00", extra: Record<string, unknown> = {}) => ({
    checkout_id: "chk_test123",
    status: "completed",
    payment_status: "paid",
    reference: topupId,
    amount,
    currency: "NGN",
    metadata: { topupId },
    charge: { id: "ch_test123", amount, currency: "NGN", status: "succeeded", settlement_amount: (Number(amount) - 30).toFixed(2) },
    ...extra,
  });

  async function openTopUp(r: Awaited<ReturnType<typeof makeRider>>, amountKobo = 200_000) {
    onBachs("POST", "/v1/checkout-sessions", () => ({ json: { checkout_id: "chk_test123", checkout_url: "https://checkout.bachs.io/c/x", status: "open" } }));
    const t = await createTopUp(r.actor, { amountKobo, idempotencyKey: keyOf() });
    const call = bachsCalls.find((c) => c.path === "/v1/checkout-sessions")!;
    assert.equal(call.body.pricing.amount, "2000.00");
    assert.equal(call.body.reference, t.topupId);
    assert.equal(call.headers["idempotency-key"], t.topupId);
    assert.deepEqual(call.body.payment_method_types, ["NGN_CARD", "NGN_BANK_TRANSFER"]);
    return t;
  }

  const event = (id: string, topupId: string, type = "collection.succeeded") => ({
    id,
    type,
    organization_id: "acct_konduct",
    data: { checkout_id: "chk_test123", reference: topupId, payment_status: "paid", status: "SUCCEEDED", amount: "2000.00", currency: "NGN" },
  });

  test("a signed, API-confirmed top-up credits exactly once, whatever arrives and however often", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout(t.topupId) }));
    const e1 = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(e1.req, e1.res);
    assert.equal(e1.res.code, 200);
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
    assert.equal(await balance(PLATFORM.bachsFees) >= 3_000, true);

    const again = webhook(JSON.parse(e1.req.rawBody.toString()));
    await handleBachsWebhook(again.req, again.res); // redelivery of the same event
    const other = webhook(event(evtId(), t.topupId, "checkout.completed"));
    await handleBachsWebhook(other.req, other.res); // the sibling event
    assert.equal(other.res.code, 200);
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
    assert.equal((await verifyAccount(riderAccount(r.uid))).ok, true);
  });

  test("a missed webhook is recovered by refreshTopUps, and the receipt verifies against the ledger", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    // No webhook ever arrives; the rider pulls to refresh.
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout(t.topupId) }));
    assert.deepEqual(await refreshTopUps(r.actor), { checked: 1, credited: 1 });
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
    assert.deepEqual(await refreshTopUps(r.actor), { checked: 0, credited: 0 });
    // A late webhook afterwards changes nothing.
    const late = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(late.req, late.res);
    assert.equal(await balance(riderAccount(r.uid)), 200_000);

    const proof = await receiptProof(r.actor, { kind: "topup", id: t.topupId });
    assert.equal(proof.verified, true);
    assert.equal(proof.amountKobo, 200_000);
    assert.equal(proof.balanceAfterKobo, 200_000);
    const page = await lookUpReceipt(proof.code!);
    assert.equal(page?.genuine, true);
    assert.equal(page?.amountKobo, 200_000);
    assert.equal(page?.type, "Wallet top-up");
    // A guessed or altered code finds nothing; another rider can't get proof of this top-up.
    const flipped = proof.code!.slice(0, -1) + (proof.code!.endsWith("0") ? "1" : "0");
    assert.equal(await lookUpReceipt(flipped), null);
    const other = await makeRider(0);
    assert.equal((await receiptProof(other.actor, { kind: "topup", id: t.topupId })).posted, false);
  });

  test("a payment Bachs reports without our reference is matched by its checkout id", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    // Bachs only includes the reference "when available": neither the event nor the lookup has it.
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: { ...paidCheckout(t.topupId), reference: null, metadata: {} } }));
    const e = webhook({ id: evtId(), type: "collection.succeeded", organization_id: "acct_konduct", data: { checkout_id: "chk_test123", charge_id: "ch_test123", status: "SUCCEEDED", amount: "2000.00", currency: "NGN" } });
    await handleBachsWebhook(e.req, e.res);
    assert.equal(e.res.code, 200);
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
    assert.equal((await db.doc(`topups/${t.topupId}`).get()).get("lastCheck").why, "credited");
  });

  test("a checkout Bachs reports as completed/succeeded counts as paid", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: { ...paidCheckout(t.topupId), payment_status: "succeeded" } }));
    assert.deepEqual(await refreshTopUps(r.actor), { checked: 1, credited: 1 });
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
  });

  test("the 15-minute job credits a paid top-up whose webhook never came", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout(t.topupId) }));
    const out = await reconcileTopUps();
    assert.equal(out.credited >= 1, true);
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
  });

  test("refreshTopUps marks a checkout Bachs has expired, and credits nothing", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: { checkout_id: "chk_test123", status: "expired", payment_status: "unpaid", reference: t.topupId } }));
    assert.deepEqual(await refreshTopUps(r.actor), { checked: 1, credited: 0 });
    assert.equal((await db.doc(`topups/${t.topupId}`).get()).get("status"), "expired");
    assert.equal(await balance(riderAccount(r.uid)), 0);
  });

  test("forged, tampered and stale webhooks are refused with 400 and credit nothing", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout(t.topupId) }));
    for (const w of [
      webhook(event(evtId(), t.topupId), { secret: "whsec_attacker" }),
      webhook(event(evtId(), t.topupId), { tamper: true }),
      webhook(event(evtId(), t.topupId), { ts: Math.floor(Date.now() / 1000) - 3600 }),
    ]) {
      await handleBachsWebhook(w.req, w.res);
      assert.equal(w.res.code, 400);
      assert.equal(w.res.text, "invalid signature");
    }
    assert.equal(await balance(riderAccount(r.uid)), 0);
  });

  test("a genuine event is still not trusted: the API must agree (SEC-PAY-03)", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    // The webhook says paid; Bachs's API says the checkout is still open.
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: { ...paidCheckout(t.topupId), status: "open", payment_status: "unpaid" } }));
    const w = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(w.req, w.res);
    assert.equal(w.res.code, 200, "a genuine delivery is acknowledged");
    assert.equal(await balance(riderAccount(r.uid)), 0);
    // A checkout that belongs to another reference, or another currency, is not credited either.
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout("tu_someoneelse") }));
    const w2 = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(w2.req, w2.res);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: { ...paidCheckout(t.topupId), charge: { id: "c", amount: "2000.00", currency: "USD", status: "succeeded" } } }));
    const w3 = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(w3.req, w3.res);
    assert.equal(w2.res.code, 200);
    assert.equal(w3.res.code, 200);
    assert.equal(await balance(riderAccount(r.uid)), 0);
    const flags = await db.collection("flags").where("topupId", "==", t.topupId).get();
    assert.ok(flags.docs.some((f) => f.get("type") === "topup_reference_mismatch"));
    assert.ok(flags.docs.some((f) => f.get("type") === "topup_currency_mismatch"));
  });

  test("events from accounts that aren't ours are refused", async () => {
    const w = webhook({ id: evtId(), type: "collection.succeeded", organization_id: "acct_stranger", data: {} });
    await handleBachsWebhook(w.req, w.res);
    assert.equal(w.res.code, 400);
    assert.equal(w.res.text, "unknown account");
  });

  test("bank deposits: funding code credits the rider, unknown senders go to suspense", async () => {
    const r = await makeRider(0, { fundingCode: "KDTEST01" });
    await db.doc("fundingCodes/KDTEST01").set({ uid: r.uid, ...stamp() });
    const dep = (id: string, narration: string | null, acct = "0123456789") => ({
      id,
      type: "collection.succeeded",
      organization_id: "acct_konduct",
      data: {
        charge_id: uniq("ch_"),
        checkout_id: null,
        status: "SUCCEEDED",
        amount: "5000.00",
        currency: "NGN",
        settlement_amount: "4950.00",
        payment_method_details: { type: "bank_transfer", bank_transfer: { sender_name: "ADA OKAFOR", sender_bank_code: "058", sender_account_number: acct, narration, virtual_account: { type: "permanent" } } },
      },
    });
    const w1 = webhook(dep(evtId(), "kd test01 transport"));
    await handleBachsWebhook(w1.req, w1.res);
    assert.equal(await balance(riderAccount(r.uid)), 500_000);
    // Same sender, no narration this time: recognised from the first deposit.
    const w2 = webhook(dep(evtId(), null));
    await handleBachsWebhook(w2.req, w2.res);
    assert.equal(await balance(riderAccount(r.uid)), 1_000_000);
    // A stranger with no code: parked, never guessed.
    const before = await balance(PLATFORM.suspense);
    const w3 = webhook(dep(evtId(), "thanks", "9999999999"));
    await handleBachsWebhook(w3.req, w3.res);
    assert.equal((await balance(PLATFORM.suspense)) - before, 500_000);
  });
});

describe("driver payouts via Bachs Connect", () => {
  test("bank account needs a fresh password sign-in + PIN + a second person; then pays out once", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(500_000);
    for (let i = 0; i < 4; i++) await pay(r, d.token, { repeat: true }); // driver earns ₦800
    await setPin(d.uid, "2580");

    onBachs("POST", "/v1/accounts", () => ({ json: { id: "acct_driver1" } }));
    onBachs("POST", "/v1/accounts/acct_driver1", () => ({ json: { id: "acct_driver1" } }));
    onBachs("GET", "/v1/payouts/destinations", () => ({ json: { data: [{ id: "pd_1", is_usable: true, status: "approved", account_name: "ADEBAYO TUNDE", account_number: "******6789", bank_code: "058" }] } }));
    onBachs("POST", "/v1/payouts/destinations", () => ({ json: { id: "pd_1", is_usable: true, status: "approved", account_name: "ADEBAYO TUNDE", account_number: "******6789", bank_code: "058" } }));
    onBachs("GET", "/v1/payouts/destinations/pd_1", () => ({ json: { id: "pd_1", is_usable: true, status: "approved" } }));

    const stale = actorFor(d.uid, "driver", d.actor.user, Math.floor(Date.now() / 1000) - 3600);
    assert.equal(await reason(setPayoutAccount(stale, { bankCode: "058", accountNumber: "0123456789", pin: "2580" })), "reauth_required");
    const set = await setPayoutAccount({ ...d.actor, user: (await db.doc(`users/${d.uid}`).get()).data()! }, { bankCode: "058", accountNumber: "0123456789", pin: "2580" });
    assert.equal(set.nameMatches, true);
    assert.equal((await payoutDriver(d.uid, "daily")).status, "no_payout_account");

    const approval = (await db.collection("approvals").where("kind", "==", "payout_account").where("makerUid", "==", d.uid).get()).docs[0];
    const ops = actorFor(uniq("ops"), "ops", { role: "ops", status: "active" });
    assert.equal(await reason(decide({ ...ops, uid: d.uid }, approval.id, "approve")), "same_person");
    await decide(ops, approval.id, "approve");
    assert.equal((await payoutDriver(d.uid, "daily")).status, "new_account_hold"); // FR-DRV-05 24h hold
    const paId = (await db.doc(`users/${d.uid}`).get()).get("payoutAccountId");
    await db.doc(`payoutAccounts/${paId}`).update({ holdUntilMs: Date.now() - 1 });

    onBachs("POST", "/v1/transfers", (b) => ({ json: { id: "tr_1", status: "paid", amount: b.amount, currency: "NGN" } }));
    onBachs("POST", "/v1/payouts", (b) => ({ json: { id: "pay_1", status: "pending", amount: b.amount, fee: "50.00", reference: b.reference } }));
    const run = await payoutDriver(d.uid, "daily");
    assert.equal(run.status, "submitted");
    assert.equal(run.amountKobo, 80_000);
    assert.equal(await balance(driverAccount(d.uid)), 0);
    const transfer = bachsCalls.find((c) => c.path === "/v1/transfers")!;
    assert.equal(transfer.body.amount, "850.00"); // amount + Konduct-paid ₦50 fee
    const payout = bachsCalls.find((c) => c.method === "POST" && c.path === "/v1/payouts")!;
    assert.equal(payout.headers["x-account-id"], "acct_driver1");
    assert.equal(payout.body.amount, "800.00");

    // A second run while one is in flight does nothing.
    assert.equal((await payoutDriver(d.uid, "daily")).status, "payout_in_progress");

    await onPayoutEvent("payout.paid", run.payoutId!, { withdrawal_fee: "50.00" });
    await onPayoutEvent("payout.paid", run.payoutId!, { withdrawal_fee: "50.00" }); // duplicate
    assert.equal((await db.doc(`payouts/${run.payoutId}`).get()).get("status"), "paid");
    assert.equal((await verifyAccount(driverAccount(d.uid))).ok, true);
  });

  test("a payout the bank rejects comes back to the driver's wallet", async () => {
    const d = await makeDriverWithVehicle(60_000);
    const r = await makeRider(500_000);
    await setPin(r.uid, "2580");
    await pay(r, d.token, { pin: "2580" });
    await db.runTransaction(async (tx) => {
      const pa = db.collection("payoutAccounts").doc();
      tx.set(pa, { uid: d.uid, bachsAccountId: "acct_d2", destinationId: "pd_2", accountLast4: "1111", status: "active", holdUntilMs: 0, ...stamp() });
      tx.update(db.doc(`users/${d.uid}`), { payoutAccountId: pa.id });
    });
    onBachs("GET", "/v1/payouts/destinations/pd_2", () => ({ json: { id: "pd_2", is_usable: true } }));
    onBachs("POST", "/v1/transfers", (b) => ({ json: { id: uniq("tr_"), status: "paid", amount: b.amount, currency: "NGN" } }));
    onBachs("POST", "/v1/payouts", (b) => ({ json: { id: "pay_2", status: "pending", amount: b.amount, reference: b.reference } }));
    const run = await payoutDriver(d.uid, "driver_request");
    assert.equal(await balance(driverAccount(d.uid)), 0);
    await onPayoutEvent("payout.failed", run.payoutId!, {});
    assert.equal(await balance(driverAccount(d.uid)), 60_000);
    const back = bachsCalls.find((c) => c.path === "/v1/transfers" && c.body.destination === "self");
    assert.ok(back, "money pulled back from the driver's Bachs account");
    assert.equal((await verifyAccount(driverAccount(d.uid))).ok, true);
  });

  test("a student withdraws part of their wallet; a failed payout comes back to it", async () => {
    const r = await makeRider(300_000);
    await setPin(r.uid, "2580");
    assert.equal(await reason(requestRiderWithdrawal(r.actor, { amountKobo: 100_000, pin: "2580" })), "no_payout_account");
    await db.runTransaction(async (tx) => {
      const pa = db.collection("payoutAccounts").doc();
      tx.set(pa, { uid: r.uid, bachsAccountId: "acct_r1", destinationId: "pd_r1", accountLast4: "4321", status: "active", holdUntilMs: 0, ...stamp() });
      tx.update(db.doc(`users/${r.uid}`), { payoutAccountId: pa.id });
    });
    onBachs("GET", "/v1/payouts/destinations/pd_r1", () => ({ json: { id: "pd_r1", is_usable: true } }));
    onBachs("POST", "/v1/transfers", (b) => ({ json: { id: uniq("tr_"), status: "paid", amount: b.amount, currency: "NGN" } }));
    onBachs("POST", "/v1/payouts", (b) => ({ json: { id: "pay_r1", status: "pending", amount: b.amount, reference: b.reference } }));

    assert.equal(await reason(requestRiderWithdrawal(r.actor, { amountKobo: 400_000, pin: "2580" })), "insufficient_funds");
    const w = await requestRiderWithdrawal(r.actor, { amountKobo: 100_000, pin: "2580" });
    assert.equal(w.amountKobo, 100_000);
    assert.equal(await balance(riderAccount(r.uid)), 200_000); // only what they asked for
    const transfer = bachsCalls.find((c) => c.path === "/v1/transfers" && c.body.transfer_group === w.payoutId)!;
    assert.equal(transfer.body.amount, "1050.00"); // Konduct covers the ₦50 fee
    assert.equal(transfer.body.description, "Konduct wallet withdrawal");

    await onPayoutEvent("payout.failed", w.payoutId!, {});
    assert.equal(await balance(riderAccount(r.uid)), 300_000);
    assert.equal((await verifyAccount(riderAccount(r.uid))).ok, true);
  });

  test("payouts stop when the kill switch is on", async () => {
    await db.doc("config/switches").set({ payoutsPaused: true });
    try {
      const d = await makeDriverWithVehicle();
      assert.equal((await payoutDriver(d.uid, "daily")).status, "paused");
    } finally {
      await db.doc("config/switches").set({ payoutsPaused: false });
    }
  });
});

describe("driver onboarding by email + agent code", () => {
  const agent = () => actorFor(uniq("agt"), "agent", { role: "agent", status: "active" });
  const routeFor = async () => {
    const id = uniq("route");
    await db.doc(`routes/${id}`).set({ name: "Main Gate → Faculty", stops: ["Main Gate", "Faculty"], fareKobo: 20_000, fareVersion: 1, active: true, ...stamp() });
    return id;
  };
  const invite = async (email: string) =>
    inviteDriver(agent(), {
      email,
      fullName: "Tunde Adebayo",
      plate: "OS 452 KJA",
      type: "shuttle",
      routeId: await routeFor(),
      capacity: 14,
      checks: { idSeen: true, vehiclePapersSeen: true, unionConfirmed: true },
    });
  const newUser = async (email: string) => {
    const uid = uniq("usr");
    await auth.createUser({ uid, email, password: "test-password-1" });
    return uid;
  };

  test("the right code links the driver; the code is never stored", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode, vehicleId } = await invite(email);
    assert.match(onboardingCode, /^[0-9A-Z]{8}$/);
    const stored = (await db.collection("driverInvites").where("email", "==", email).get()).docs[0].data();
    assert.ok(!JSON.stringify(stored).includes(onboardingCode), "only a keyed hash is stored");
    const uid = await newUser(email);
    const out = await claimDriverAccount(uid, email, undefined, onboardingCode.toLowerCase());
    assert.equal(out.invited, true);
    assert.equal((await db.doc(`users/${uid}`).get()).get("role"), "driver");
    assert.equal((await db.doc(`vehicles/${vehicleId}`).get()).get("driverUid"), uid);
    assert.equal((await auth.getUser(uid)).customClaims?.role, "driver");
  });

  test("wrong codes count down, then lock the invite until an agent resets it", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode } = await invite(email);
    const uid = await newUser(email);
    for (let left = 4; left >= 1; left--) {
      const r = await claimDriverAccount(uid, email, undefined, "AAAAAAAA").catch((e) => e);
      assert.equal((r.details as { reason: string }).reason, "code_wrong");
      assert.equal((r.details as { attemptsLeft: number }).attemptsLeft, left);
    }
    assert.equal(await reason(claimDriverAccount(uid, email, undefined, "AAAAAAAA")), "invite_locked");
    assert.equal(await reason(claimDriverAccount(uid, email, undefined, onboardingCode)), "invite_locked"); // even the right one
    const fresh = await resetDriverCode(agent(), email);
    assert.notEqual(fresh.onboardingCode, onboardingCode);
    assert.equal(await reason(claimDriverAccount(uid, email, undefined, onboardingCode)), "code_wrong"); // the old code is dead
    assert.equal((await claimDriverAccount(uid, email, undefined, fresh.onboardingCode)).invited, true);
  });

  test("a claimed invite can't be taken over by another account", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode } = await invite(email);
    const owner = await newUser(email);
    await claimDriverAccount(owner, email, undefined, onboardingCode);
    const intruder = uniq("usr"); // e.g. the same email re-registered after the owner's account was deleted
    assert.equal(await reason(claimDriverAccount(intruder, email, undefined, onboardingCode)), "invite_claimed");
    assert.equal(await reason(resetDriverCode(agent(), email)), "invite_claimed");
  });

  test("an email no agent registered changes nothing", async () => {
    const uid = await newUser(`${uniq("nobody").toLowerCase()}@gmail.com`);
    const out = await claimDriverAccount(uid, "nobody-here@gmail.com", undefined, "KD7F3Q2X");
    assert.deepEqual(out, { invited: false });
    assert.equal((await db.doc(`users/${uid}`).get()).exists, false);
  });

  test("a student account can't claim a driver invite", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode } = await invite(email);
    assert.equal(await reason(claimDriverAccount(uniq("usr"), email, "rider", onboardingCode)), "wrong_role");
  });

  test("members must sign in with email + password", () => {
    const req = (token: Record<string, unknown>) => ({ auth: { uid: "u1", token } }) as never;
    assert.equal(memberToken(req({ email: "Ada@X.com", firebase: { sign_in_provider: "password" } })).email, "ada@x.com");
    for (const token of [
      { phone_number: "+2348030000000", firebase: { sign_in_provider: "phone" } },
      { firebase: { sign_in_provider: "anonymous" } },
      { email: "ada@x.com", firebase: { sign_in_provider: "custom" } },
    ]) {
      assert.throws(() => memberToken(req(token)), /Sign in with your email/);
    }
    assert.throws(() => memberToken({ auth: undefined } as never), /Sign in with your email/);
  });
});

describe("disputes and books", () => {
  test("a refund reverses the fare; large refunds need a second person", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const out = await pay(r, d.token);
    await openDispute(r.actor, { txId: out.txId, reason: "charged_twice", note: "scanned twice" });
    assert.equal(await reason(openDispute(r.actor, { txId: out.txId, reason: "other", note: "" })), "dispute_exists");
    const other = await makeRider(0);
    assert.equal(await reason(openDispute(other.actor, { txId: out.txId, reason: "other", note: "" })), "bad_tx");
    const sup = actorFor(uniq("sup"), "support", { role: "support", status: "active" });
    await reviewDispute(sup, out.txId);
    await resolveDispute(sup, { disputeId: out.txId, outcome: "refund", note: "duplicate confirmed" });
    assert.equal(await balance(riderAccount(r.uid)), 100_000);
    assert.equal(await balance(driverAccount(d.uid)), 0);
  });

  test("tampering with a ledger entry is detected", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    await pay(r, d.token);
    assert.equal((await verifyAccount(riderAccount(r.uid))).ok, true);
    const entry = (await db.collection("ledgerEntries").where("account", "==", riderAccount(r.uid)).orderBy("seq").limit(1).get()).docs[0];
    await entry.ref.update({ amountKobo: entry.get("amountKobo") + 1 });
    const v = await verifyAccount(riderAccount(r.uid));
    assert.equal(v.ok, false);
  });

  test("reconciliation halts payouts when the books and Bachs disagree", async () => {
    onBachs("GET", "/v1/balances", () => ({ json: { balances: [{ currency: "NGN", available_balance: "1.00" }] } }));
    const report = await reconcile();
    assert.equal(report.ok, false);
    assert.equal((await db.doc("config/switches").get()).get("payoutsHaltedByRecon"), true);
    await db.doc("config/switches").set({ payoutsHaltedByRecon: false }, { merge: true });
  });
});


describe("approvals and staff messages", () => {
  const admin = () => actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });

  test("an admin may approve their own request; ops still need a second person", async () => {
    const r = await makeRider(0);
    const a = admin();
    const own = await requestKycTier(a, r.uid, 2);
    const done = await decide(a, own.approvalId, "approve");
    assert.equal(done.status, "approved");
    assert.equal((await db.doc(`users/${r.uid}`).get()).get("kycTier"), 2);
    assert.equal((await db.doc(`approvals/${own.approvalId}`).get()).get("selfApproved"), true);

    const ops = actorFor(uniq("ops"), "ops", { role: "ops", status: "active" });
    const adj = await requestAdjustment(ops, { account: riderAccount(r.uid), side: "credit", amountKobo: 100, memo: "test credit" });
    assert.equal(await reason(decide(ops, adj.approvalId, "approve")), "same_person");
  });

  test("a message to one person lands in their inbox; a group message is one broadcast doc", async () => {
    const r = await makeRider(0);
    const one = await sendNotice(admin(), { audience: "one", to: r.uid, title: "Hello", body: "Welcome to Konduct", popup: true, push: false, link: "app:topup", linkLabel: "Top up" });
    assert.equal(one.sentTo, 1);
    const inbox = await db.collection(`users/${r.uid}/notifications`).get();
    assert.equal(inbox.size, 1);
    assert.equal(inbox.docs[0].get("popup"), true);
    assert.equal(inbox.docs[0].get("link"), "app:topup");

    const group = await sendNotice(admin(), { audience: "rider", title: "Free rides", body: "All day Friday", popup: false, push: false });
    const b = await db.doc(`broadcasts/${group.id}`).get();
    assert.equal(b.get("active"), true);
    assert.equal(b.get("audience"), "rider");
    assert.equal(await reason(sendNotice(admin(), { audience: "one", to: "nobody@konduct.test", title: "Hi", body: "Hello there", popup: false, push: false })), "no_such_person");
  });

  test("ads keep their schedule and links; images must really be images", async () => {
    const ad = await upsertAd(admin(), {
      placement: "carousel",
      audience: "all",
      title: "Ride more",
      body: "",
      imageUrl: "https://example.com/a.jpg",
      link: "https://konduct.app",
      buttons: [{ label: "Learn more", link: "app:topup" }],
      active: true,
      startsAtMs: null,
      endsAtMs: null,
      order: 1,
    });
    assert.equal((await db.doc(`ads/${ad.id}`).get()).get("buttons")[0].label, "Learn more");
    await deleteAd(admin(), { id: ad.id });
    assert.equal((await db.doc(`ads/${ad.id}`).get()).exists, false);
    assert.equal(await reason(uploadMedia(admin(), { contentType: "image/png", data: Buffer.from("not a png at all").toString("base64") })), "not_an_image");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const up = await uploadMedia(admin(), { contentType: "image/png", data: png.toString("base64") });
    assert.match(up.url, /\/media\/[A-Za-z0-9_-]+$/);
  });
});

describe("people and staff accounts (admin)", () => {
  const admin = () => actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });

  test("an admin adds staff by email: verified account, role, one-time password; revoking shuts them out", async () => {
    const a = admin();
    const email = `${uniq("new").toLowerCase()}@konduct.test`;
    const added = await addStaff(a, { email, role: "support" });
    assert.match(added.password, /^[A-Za-z2-9]{14}$/);
    const user = await auth.getUser(added.uid);
    assert.equal(user.emailVerified, true);
    assert.equal(user.customClaims?.role, "support");
    assert.equal(user.customClaims?.staff, true);
    const profile = await db.doc(`users/${added.uid}`).get();
    assert.equal(profile.get("role"), "support");
    assert.equal(profile.get("mustChangePassword"), true);

    await markPasswordChosen(added.uid);
    assert.equal((await db.doc(`users/${added.uid}`).get()).get("mustChangePassword"), false);

    await setStaffRole(a, added.uid, "ops");
    assert.equal((await auth.getUser(added.uid)).customClaims?.role, "ops");
    const reset = await resetStaffPassword(a, added.uid);
    assert.notEqual(reset.password, added.password);
    assert.equal((await db.doc(`users/${added.uid}`).get()).get("mustChangePassword"), true);

    await revokeStaff(a, added.uid);
    const gone = await auth.getUser(added.uid);
    assert.equal(gone.disabled, true);
    assert.equal(gone.customClaims?.staff, false);
    assert.equal((await db.doc(`users/${added.uid}`).get()).get("role"), "none");
    assert.equal(await reason(setStaffRole(a, added.uid, "admin")), "not_staff");

    // Adding the same email again brings them back with a new password.
    const back = await addStaff(a, { email, role: "agent" });
    assert.equal(back.uid, added.uid);
    assert.equal((await auth.getUser(added.uid)).disabled, false);
    assert.equal(await reason(revokeStaff(actorFor(added.uid, "admin", {}), added.uid)), "self");
  });

  test("a student or driver email can't be made staff", async () => {
    const r = await makeRider(0);
    await db.doc(`users/${r.uid}`).update({ email: r.email });
    assert.equal(await reason(addStaff(admin(), { email: r.email, role: "support" })), "member_email");
  });

  test("an admin edits a rider's details; the student ID claim moves and clashes are refused", async () => {
    const studentId = `T-${uniq("s").toUpperCase()}`;
    const r = await makeRider(0, { studentId });
    const other = await makeRider(0);
    await db.doc(`studentIds/${studentIdKey(CAMPUS_ID, studentId)}`).set({ uid: r.uid, studentId });
    const nextId = `T-${uniq("n").toUpperCase()}`;
    const newEmail = `${uniq("mail").toLowerCase()}@konduct.test`;
    const out = await updateUserDetails(admin(), UpdateUser.parse({ uid: r.uid, fullName: "Ada  Obi", studentId: nextId, email: newEmail }));
    assert.deepEqual(out.changed.sort(), ["email", "fullName", "studentId"]);
    const u = await db.doc(`users/${r.uid}`).get();
    assert.equal(u.get("fullName"), "Ada Obi");
    assert.equal(u.get("studentId"), nextId);
    assert.equal((await auth.getUser(r.uid)).email, newEmail);
    assert.equal((await auth.getUser(r.uid)).customClaims?.name, "Ada Obi");
    const keys = (await db.collection("studentIds").where("uid", "==", r.uid).get()).docs.map((d) => d.get("studentId"));
    assert.deepEqual(keys, [nextId]);
    assert.equal(await reason(updateUserDetails(admin(), { uid: other.uid, studentId: nextId })), "student_id_taken");
    assert.equal(await reason(updateUserDetails(admin(), { uid: other.uid, email: newEmail })), "email_taken");
  });
});

describe("the riders' bus board", () => {
  const admin = () => actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });
  const entry = async (vehicleId: string) => (await db.doc(`liveBuses/${vehicleId}`).get()).data();

  test("a bus checks in at a park, fills by scan, leaves; riders see it all without driver ids", async () => {
    const d = await makeDriverWithVehicle(5_000);
    const parkId = uniq("park");
    await db.doc(`parks/${parkId}`).set({ name: "Shasha park", location: "Gate 2", active: true, busCount: 0, ...stamp() });
    await rebuildBoard();
    const seats = readFleet(await fleetRef().get()).busSeats;
    let e = await entry(d.vehicleId);
    assert.equal(e?.plate, "OS 452 KJA");
    assert.equal(e?.driverFirstName, "Tunde");
    assert.equal(e?.capacity, seats);
    assert.equal(e?.seatsTaken, 0);
    assert.equal(e?.park, null);
    assert.equal(e?.fareKobo, 5_000);
    assert.equal(e?.driverUid, undefined);
    assert.equal(e?.shortCode, undefined);

    const other = await makeDriverWithVehicle(5_000);
    assert.equal(await reason(setVehiclePark(other.actor, d.vehicleId, parkId)), "not_your_vehicle");
    await setVehiclePark(d.actor, d.vehicleId, parkId);
    e = await entry(d.vehicleId);
    assert.equal(e?.park.name, "Shasha park");

    const r = await makeRider(100_000);
    await pay(r, d.token, { passengers: 3 });
    e = await entry(d.vehicleId);
    assert.equal(e?.seatsTaken, 3);
    assert.ok(e?.seatsResetAtMs > Date.now());

    await setVehiclePark(d.actor, d.vehicleId, null);
    assert.equal((await entry(d.vehicleId))?.park, null);

    // A check-in the driver forgot about lapses on its own.
    await setVehiclePark(d.actor, d.vehicleId, parkId);
    await db.doc(`vehicles/${d.vehicleId}`).update({ "park.expiresAtMs": Date.now() - 1 });
    await refreshBoard(d.vehicleId);
    assert.equal((await entry(d.vehicleId))?.park, null);

    // Suspended buses drop off the board.
    await setVehicleStatus(admin(), d.vehicleId, "suspended");
    assert.equal(await entry(d.vehicleId), undefined);
    assert.equal(await reason(setVehiclePark(d.actor, d.vehicleId, parkId)), "vehicle_inactive");
  });
});
