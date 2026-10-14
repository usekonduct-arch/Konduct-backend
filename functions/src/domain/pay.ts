/**
 * Scan-to-pay (FR-PAY, FR-GRP, FR-OFF-01, SAF-01).
 *
 * preview  -> the server validates the sticker, vehicle, driver and route, prices the ride from
 *             the fare table and stores a single-use quote (SEC-QR-05). Nothing moves.
 * confirm  -> one Firestore transaction: re-checks everything, enforces limits, debits the rider,
 *             credits the driver, writes ledger entries, the transaction, one trip per passenger
 *             and the driver's live alert, and takes the riders' seats on the bus (seats.ts).
 *             Same idempotency key = same result, never a 2nd debit.
 * undo     -> 60s wrong-vehicle undo, by reversing entries (never editing them); frees the seats.
 *
 * Amounts from the client are never trusted (SEC-PAY-04): the client sends a quote id.
 */
import { z } from "zod";

import { OFFLINE_CODE_KEY, QR_SIGNING_KEY, RULES } from "../config";
import { audit } from "../lib/audit";
import { cleanCode, hmacCode, randomCode, randomId, sha256 } from "../lib/crypto";
import { db, FieldValue, millis, stamp, touched } from "../lib/db";
import { fail, isHttpsError } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { naira } from "../lib/money";
import { driverAccount, InsufficientFunds, markReversed, prepare, reversalLegs, riderAccount } from "../ledger/ledger";
import { checkPin } from "./accounts";
import { notify } from "./notify";
import { assertOpen, dailyRef, getSwitches, limitsFor, readDaily } from "./policy";
import { readVehicleToken } from "./qr";
import type { CurrentRoute } from "./landmarks";
import { alighted, assertSeats, boarded, countsSeats, fleetRef, liveLoad, type Load, readFleet } from "./seats";

const firstName = (full: unknown) => String(full ?? "").trim().split(/\s+/)[0] || "Driver";

export const PreviewInput = z.strictObject({
  qr: z.string().max(120).optional(),
  code: z.string().max(12).optional(), // short code printed on the sticker, for manual entry
  passengers: z.number().int().min(1).max(RULES.maxPassengers).default(1),
});

async function vehicleFrom(input: z.infer<typeof PreviewInput>) {
  if (input.qr) {
    const t = readVehicleToken(QR_SIGNING_KEY.value(), input.qr);
    if (!t) fail("invalid-argument", "bad_code", "That isn't a Konduct code. Check the sticker and try again.");
    const v = await db.doc(`vehicles/${t.vehicleId}`).get();
    if (!v.exists) fail("not-found", "bad_code", "That isn't a Konduct code. Check the sticker and try again.");
    // A replaced sticker is revoked the moment a new one is issued (FR-DRV-08, FR-PAY-07).
    if (v.get("tokenVersion") !== t.version) fail("failed-precondition", "sticker_revoked", "This sticker has been replaced. Please report it to the driver or an agent.");
    return v;
  }
  if (input.code) {
    const q = await db.collection("vehicles").where("shortCode", "==", cleanCode(input.code)).limit(1).get();
    if (q.empty) fail("not-found", "bad_code", "No vehicle has that code. Check the sticker and try again.");
    return q.docs[0];
  }
  fail("invalid-argument", "bad_code", "Scan the code on the vehicle.");
}

export async function previewPayment(actor: Actor, input: z.infer<typeof PreviewInput>) {
  await rateLimit(actor.uid, "preview", 30, 60_000);
  assertOpen(await getSwitches(), "payments");

  const vehicle = await vehicleFrom(input);
  const v = vehicle.data()!;
  if (v.status !== "active") fail("failed-precondition", "vehicle_inactive", "This vehicle isn't taking Konduct payments right now. Please pay in cash.");
  const bus = countsSeats(v);

  const [driver, route, wallet, recent, fleet] = await Promise.all([
    v.driverUid ? db.doc(`users/${v.driverUid}`).get() : null,
    db.doc(`routes/${v.routeId}`).get(),
    db.doc(`wallets/${riderAccount(actor.uid)}`).get(),
    db
      .collection("transactions")
      .where("payerUid", "==", actor.uid)
      .where("vehicleId", "==", vehicle.id)
      .where("createdAtMs", ">", Date.now() - RULES.repeatScanWindowMs)
      .orderBy("createdAtMs", "desc")
      .limit(1)
      .get(),
    bus ? fleetRef().get() : null,
  ]);
  const capacity = bus ? readFleet(fleet).busSeats : (v.capacity ?? RULES.maxPassengers);
  if (input.passengers > Math.min(RULES.maxPassengers, capacity)) {
    fail("invalid-argument", "too_many", "That's more passengers than this vehicle carries.");
  }
  if (!driver?.exists || driver.get("status") !== "active" || driver.get("role") !== "driver") {
    fail("failed-precondition", "driver_inactive", "This driver isn't taking Konduct payments right now. Please pay in cash.");
  }
  const switches = await getSwitches();
  if (!route.exists || route.get("active") !== true || switches.disabledRoutes.includes(route.id)) {
    fail("failed-precondition", "route_inactive", "Konduct payments are off on this route right now. Please pay in cash.");
  }
  const seatsTaken = bus ? (liveLoad(v)?.taken ?? 0) : 0;
  if (bus) assertSeats(capacity, seatsTaken, input.passengers);

  const fareKobo = route.get("fareKobo") as number;
  const totalKobo = fareKobo * input.passengers;
  const balanceKobo = (wallet.get("balanceKobo") as number) ?? 0;
  const recentTx = recent.docs[0];
  const quoteId = randomId(16);

  await db.doc(`payQuotes/${quoteId}`).create({
    uid: actor.uid,
    vehicleId: vehicle.id,
    tokenVersion: v.tokenVersion,
    driverUid: v.driverUid,
    routeId: route.id,
    fareVersion: route.get("fareVersion"),
    fareKobo,
    passengers: input.passengers,
    totalKobo,
    recentPaidAtMs: recentTx ? recentTx.get("createdAtMs") : null,
    status: "open",
    expiresAtMs: Date.now() + RULES.quoteTtlMs,
    expireAt: new Date(Date.now() + 24 * 3_600_000), // TTL clean-up
    ...stamp(),
  });

  const issuedAt = millis(v.tokenIssuedAt);
  return {
    quoteId,
    driverFirstName: firstName(driver.get("fullName")),
    plate: v.plate,
    vehicleType: v.type,
    route: route.get("name"),
    fareKobo,
    passengers: input.passengers,
    totalKobo,
    balanceKobo,
    insufficient: balanceKobo < totalKobo, // show the top-up shortcut (FR-PAY-08)
    needsPin: totalKobo >= RULES.pinThresholdKobo,
    // Ask "add another passenger or already paid?" instead of charging silently (FR-GRP-02).
    recentlyPaidThisVehicle: Boolean(recentTx),
    // Warn when a sticker was swapped recently (SEC-QR-02).
    stickerChangedRecently: v.tokenVersion > 1 && Date.now() - issuedAt < 7 * 86_400_000,
    // Seats paid by scan on this bus's current trip, before this payment (null: not a bus).
    // Cash riders aren't counted, so the app shows what's left as an estimate.
    seatCapacity: bus ? capacity : null,
    seatsTaken,
    // Where the driver says this trip goes, and about how long it takes (landmarks.ts).
    tripRoute: tripRouteOf(v.currentRoute),
    expiresInMs: RULES.quoteTtlMs,
  };
}

/** The part of a bus's current route riders see and receipts keep. */
function tripRouteOf(r: CurrentRoute | undefined) {
  return r ? { from: r.fromName, to: r.toName, etaMin: r.etaMin } : null;
}

export const ConfirmInput = z.strictObject({
  quoteId: z.string().regex(/^[A-Za-z0-9_-]{16,40}$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  pin: z.string().max(6).optional(),
  repeatConfirmed: z.boolean().default(false),
});

type PayResult = { txId: string; reference: string; totalKobo: number; passengers: number; balanceKobo: number; offlineCode: string; undoUntilMs: number; rideTokens: string[] };

export async function confirmPayment(actor: Actor, input: z.infer<typeof ConfirmInput>): Promise<PayResult> {
  const idemRef = db.doc(`idempotency/${sha256(`${actor.uid}|pay|${input.idempotencyKey}`)}`);
  const earlier = await idemRef.get();
  if (earlier.exists) {
    if (earlier.get("uid") !== actor.uid) fail("permission-denied", "bad_key", "Something went wrong. Try again.");
    return earlier.get("result") as PayResult; // SEC-PAY-01: same key returns the original result
  }

  await rateLimit(actor.uid, "confirm", 10, 60_000);
  try {
    await rateLimit(actor.uid, "pay10m", RULES.velocityMaxPays10Min, 10 * 60_000);
  } catch (e) {
    if (isHttpsError(e)) await db.collection("flags").add({ type: "velocity", uid: actor.uid, status: "open", ...stamp() });
    fail("resource-exhausted", "velocity_hold", "That's a lot of payments in a short time. Wait a few minutes, or talk to an agent.");
  }
  assertOpen(await getSwitches(), "payments");

  const quoteRef = db.doc(`payQuotes/${input.quoteId}`);
  const quote = await quoteRef.get();
  if (!quote.exists || quote.get("uid") !== actor.uid) fail("not-found", "quote_missing", "Scan the code again to pay.");
  if (quote.get("status") !== "open") {
    // A double-tap or retry can arrive just after the first request paid: give back that result.
    const done = await idemRef.get();
    if (done.exists && done.get("uid") === actor.uid) return done.get("result") as PayResult;
    fail("failed-precondition", "quote_used", "This scan was already used. Scan again to pay.");
  }
  if (quote.get("expiresAtMs") < Date.now()) fail("deadline-exceeded", "quote_expired", "That took a while. Scan the code again.");
  if (quote.get("recentPaidAtMs") && !input.repeatConfirmed) {
    fail("failed-precondition", "repeat_scan", "You paid this vehicle a few minutes ago. Adding another passenger, or did you already pay?");
  }
  const q = quote.data()!;
  if (q.totalKobo >= RULES.pinThresholdKobo) await checkPin(actor.uid, input.pin);

  const txId = `fare_${randomId(12)}`;
  const reference = `KD-${randomCode(6)}`;
  const offlineCode = hmacCode(OFFLINE_CODE_KEY.value(), txId, 6);
  const rideTokens = Array.from({ length: q.passengers }, () => randomCode(8));
  const now = Date.now();

  let result: PayResult;
  try {
    result = await db.runTransaction(async (tx) => {
      const [idem, qq, vehicle, driver, rider, route, daily, switchesSnap, fleet] = await tx.getAll(
        idemRef,
        quoteRef,
        db.doc(`vehicles/${q.vehicleId}`),
        db.doc(`users/${q.driverUid}`),
        db.doc(`users/${actor.uid}`),
        db.doc(`routes/${q.routeId}`),
        dailyRef(actor.uid),
        db.doc("config/switches"),
        fleetRef(),
      );
      if (idem.exists) return idem.get("result") as PayResult;
      if (qq.get("status") !== "open") fail("failed-precondition", "quote_used", "This scan was already used. Scan again to pay.");
      if (switchesSnap.get("paymentsPaused")) fail("unavailable", "payments_paused", "Payments are paused for a moment. Please pay the driver in cash.");
      if (vehicle.get("status") !== "active" || vehicle.get("tokenVersion") !== q.tokenVersion || vehicle.get("driverUid") !== q.driverUid) {
        fail("failed-precondition", "vehicle_changed", "This vehicle's details changed. Scan again.");
      }
      if (driver.get("status") !== "active") fail("failed-precondition", "driver_inactive", "This driver isn't taking Konduct payments right now. Please pay in cash.");
      if (rider.get("status") !== "active") fail("permission-denied", "account_locked", "This account is on hold. Talk to a Konduct agent or support.");
      if (route.get("active") !== true || route.get("fareVersion") !== q.fareVersion) fail("failed-precondition", "fare_changed", "The fare changed. Scan again to see the new price.");

      const tripRoute = tripRouteOf(vehicle.get("currentRoute"));

      // Seats: re-checked here, where parallel scans of one bus are serialised on its document.
      let load: Load | null = null;
      if (countsSeats(vehicle.data())) {
        const current = liveLoad(vehicle.data(), now);
        assertSeats(readFleet(fleet).busSeats, current?.taken ?? 0, q.passengers);
        load = boarded(current, q.passengers, now);
      }

      // Limits by KYC tier, counting group payments in full (FR-WAL-06, FR-GRP-06).
      const lim = limitsFor(rider.get("kycTier"));
      const d = readDaily(daily);
      if (q.totalKobo > lim.perTxKobo) fail("failed-precondition", "over_tx_limit", `The most you can pay at once is ${naira(lim.perTxKobo)}.`);
      if (d.spendKobo + q.totalKobo > lim.dailySpendKobo) fail("failed-precondition", "over_daily_limit", `You've reached today's limit of ${naira(lim.dailySpendKobo)}.`);

      const ledger = await prepare(tx, {
        txId,
        type: "fare",
        legs: [
          { account: riderAccount(actor.uid), side: "debit", amountKobo: q.totalKobo },
          { account: driverAccount(q.driverUid), side: "credit", amountKobo: q.totalKobo },
        ],
        refs: { quoteId: input.quoteId, vehicleId: q.vehicleId, reference },
      });
      ledger.commit();

      const r: PayResult = {
        txId,
        reference,
        totalKobo: q.totalKobo,
        passengers: q.passengers,
        balanceKobo: ledger.balance(riderAccount(actor.uid)),
        offlineCode,
        undoUntilMs: now + RULES.undoWindowMs,
        rideTokens,
      };
      tx.create(db.doc(`transactions/${txId}`), {
        type: "fare",
        status: "completed",
        reference,
        payerUid: actor.uid,
        driverUid: q.driverUid,
        vehicleId: q.vehicleId,
        plate: vehicle.get("plate"),
        routeId: q.routeId,
        routeName: route.get("name"),
        fareVersion: q.fareVersion,
        fareKobo: q.fareKobo,
        passengers: q.passengers,
        totalKobo: q.totalKobo,
        offlineCode,
        driverConfirmedAt: null,
        undoUntilMs: r.undoUntilMs,
        quoteId: input.quoteId,
        tripStartedAtMs: load?.tripStartedAtMs ?? null, // which bus trip these seats belong to (undo gives them back)
        tripRoute,
        driverFirstName: firstName(driver.get("fullName")),
        // The rider can rate the driver once the trip should be over (ratings.ts).
        rateFromMs: now + (tripRoute ? tripRoute.etaMin * 60_000 : RULES.rateWithoutRouteMs),
        rating: null,
        createdAtMs: now,
        ...stamp(),
      });
      rideTokens.forEach((token, i) =>
        tx.create(db.doc(`trips/${txId}_${i + 1}`), {
          txId,
          vehicleId: q.vehicleId,
          routeId: q.routeId,
          riderUid: actor.uid,
          driverUid: q.driverUid,
          paidFor: i === 0 ? "self" : "friend",
          rideToken: token,
          status: "valid",
          ...stamp(),
        }),
      );
      // The driver's app listens here for the loud alert (FR-PAY-05, FR-GRP-04).
      tx.create(db.doc(`driverFeed/${q.driverUid}/items/${txId}`), {
        amountKobo: q.totalKobo,
        riders: q.passengers,
        reference,
        status: "paid",
        atMs: now,
        ...stamp(),
      });
      if (load) tx.update(vehicle.ref, { load });
      tx.update(quoteRef, { status: "used", txId, ...touched() });
      tx.set(daily.ref, { uid: actor.uid, spendKobo: FieldValue.increment(q.totalKobo), pays: FieldValue.increment(1), ...touched() }, { merge: true });
      tx.create(idemRef, { uid: actor.uid, result: r, expireAt: new Date(now + 48 * 3_600_000), ...stamp() });
      audit({ actor: actor.uid, action: "pay.confirm", target: `transactions/${txId}`, after: { totalKobo: q.totalKobo, passengers: q.passengers }, ip: actor.ip }, tx);
      return r;
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) {
      fail("failed-precondition", "insufficient_funds", "Not enough in your wallet. Top up and scan again.", { balanceKobo: e.balanceKobo, neededKobo: q.totalKobo });
    }
    throw e;
  }

  // Duplicate-charge detection: same payer, same vehicle within 60s (FR-DSP-04).
  if (q.recentPaidAtMs && now - q.recentPaidAtMs < 60_000) {
    await db.collection("flags").add({ type: "possible_duplicate", uid: actor.uid, txId: result.txId, vehicleId: q.vehicleId, status: "open", ...stamp() });
  }
  const riders = q.passengers === 1 ? "1 rider" : `${q.passengers} riders`;
  await notify(q.driverUid, "fare.received", { title: `${naira(q.totalKobo)} received`, body: `${riders} · ${reference}`, data: { txId: result.txId }, channel: "konduct_payments", critical: true });
  return result;
}

/** SAF-01: undo within 60 seconds of a wrong-vehicle payment, by reversal. */
export async function undoPayment(actor: Actor, txId: string) {
  if (!/^fare_[A-Za-z0-9_-]{8,40}$/.test(txId)) fail("invalid-argument", "bad_tx", "We couldn't find that payment.");
  await rateLimit(actor.uid, "undo", 5, 60_000);
  const txRef = db.doc(`transactions/${txId}`);
  const reversalId = `undo_${txId}`;
  try {
    return await db.runTransaction(async (tx) => {
      const t = await tx.get(txRef);
      if (!t.exists || t.get("payerUid") !== actor.uid) fail("not-found", "bad_tx", "We couldn't find that payment.");
      if (t.get("status") !== "completed") fail("failed-precondition", "not_undoable", "This payment can't be undone.");
      if (Date.now() > t.get("undoUntilMs")) fail("failed-precondition", "undo_expired", "It's too late to undo. Open a dispute from the receipt instead.");
      if (t.get("driverConfirmedAt")) fail("failed-precondition", "not_undoable", "The driver already confirmed this payment. Open a dispute instead.");
      const { legs } = await reversalLegs(tx, txId);
      const daily = await tx.get(dailyRef(actor.uid));
      const trips = await tx.get(db.collection("trips").where("txId", "==", txId));
      const vehicle = await tx.get(db.doc(`vehicles/${t.get("vehicleId")}`));
      const ledger = await prepare(tx, { txId: reversalId, type: "fare.undo", legs, reversalOf: txId });
      ledger.commit();
      markReversed(tx, txId, reversalId);
      tx.update(txRef, { status: "reversed", reversedAtMs: Date.now(), reversal: "undo", ...touched() });
      trips.docs.forEach((d) => tx.update(d.ref, { status: "void", ...touched() }));
      tx.update(db.doc(`driverFeed/${t.get("driverUid")}/items/${txId}`), { status: "undone", ...touched() });
      if (daily.exists) tx.update(daily.ref, { spendKobo: FieldValue.increment(-t.get("totalKobo")), ...touched() });
      // The rider is off the bus: give the seats back if that trip is still going.
      const load = alighted(liveLoad(vehicle.data()), t.get("passengers"), t.get("tripStartedAtMs"));
      if (load) tx.update(vehicle.ref, { load });
      audit({ actor: actor.uid, action: "pay.undo", target: txRef.path, ip: actor.ip }, tx);
      return { ok: true, balanceKobo: ledger.balance(riderAccount(actor.uid)) };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) fail("failed-precondition", "not_undoable", "This payment can't be undone now. Open a dispute from the receipt.");
    throw e;
  }
}

/**
 * FR-OFF-01: the rider paid server-side; the driver (who may have just come back online) types
 * the 6-character code from the rider's screen to confirm which payment it was.
 */
export async function confirmOfflineCode(actor: Actor, rawCode: string) {
  const code = cleanCode(rawCode);
  if (!/^[0-9A-Z]{6}$/.test(code)) fail("invalid-argument", "bad_code", "Codes are 6 letters and numbers.");
  await rateLimit(actor.uid, "offline", 20, 10 * 60_000); // 1e9 code space; this stops guessing
  const q = await db
    .collection("transactions")
    .where("driverUid", "==", actor.uid)
    .where("offlineCode", "==", code)
    .where("createdAtMs", ">", Date.now() - RULES.offlineCodeTtlMs)
    .limit(1)
    .get();
  const t = q.docs[0];
  if (!t || t.get("status") !== "completed") fail("not-found", "code_unknown", "No payment with that code. Check it with the rider.");
  if (!t.get("driverConfirmedAt")) await t.ref.update({ driverConfirmedAt: FieldValue.serverTimestamp(), ...touched() });
  return { reference: t.get("reference"), totalKobo: t.get("totalKobo"), passengers: t.get("passengers") };
}
