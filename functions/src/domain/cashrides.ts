/**
 * Cash rides at the park: a visitor without the app pays a park agent (or ops/admin) in cash, and
 * the agent pays the bus for them from the console. The driver is credited and alerted exactly as
 * for a scan, the seats are taken on the bus, and the visitor gets a ticket to show the driver.
 *
 *   preview  -> prices the ride from the fare table; nothing moves.
 *   confirm  -> one transaction: re-checks everything, debits the agent's cash account
 *               (agentAccount, debit-normal: what they owe Konduct), credits the driver, writes
 *               the transaction, the driver's live alert and the seats. Same key = same result.
 *
 * The cash is real money only once it reaches Konduct's Bachs account, so every agent carries what
 * they've collected until they hand it in:
 *   - bank it into Konduct's account; staff assign that deposit to the agent (deposit_assign,
 *     approvals.ts), which clears it against suspense, or
 *   - give it to ops/admin in person (receiveCash), which moves the debt to the person who took it.
 * An agent can't hold more than RULES.maxCashHeldKobo unbanked, so a lost phone or a bad day stays small.
 */
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { randomCode, randomId, sha256 } from "../lib/crypto";
import { db, stamp } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { naira } from "../lib/money";
import { publicBase } from "../lib/public";
import { agentAccount, driverAccount, InsufficientFunds, openAgentAccount, prepare } from "../ledger/ledger";
import { refreshBoardQuietly } from "./board";
import type { CurrentRoute } from "./landmarks";
import { notify } from "./notify";
import { assertOpen, getSwitches } from "./policy";
import { vehicleFrom } from "./pay";
import { assertSeats, boarded, countsSeats, fleetRef, liveLoad, type Load, readFleet } from "./seats";
import { countFare } from "./stats";

const firstName = (full: unknown) => String(full ?? "").trim().split(/\s+/)[0] || "Driver";
const tripRouteOf = (r: CurrentRoute | undefined) => (r ? { from: r.fromName, to: r.toName, etaMin: r.etaMin } : null);
const vehicleId = z.string().regex(/^[A-Za-z0-9_-]{3,60}$/);

export const CashRidePreview = z
  .strictObject({
    /** From the park's bus list... */
    vehicleId: vehicleId.optional(),
    /** ...or the sticker, scanned or typed. */
    qr: z.string().max(120).optional(),
    code: z.string().max(12).optional(),
    passengers: z.number().int().min(1).max(RULES.maxPassengers).default(1),
  })
  .refine((x) => [x.vehicleId, x.qr, x.code].filter(Boolean).length === 1, "Pick a bus, scan its sticker or type its code.");

async function findVehicle(input: z.infer<typeof CashRidePreview>) {
  if (input.vehicleId) {
    const v = await db.doc(`vehicles/${input.vehicleId}`).get();
    if (!v.exists) fail("not-found", "bad_code", "No vehicle has that code. Check the sticker and try again.");
    return v;
  }
  return vehicleFrom({ qr: input.qr, code: input.code, passengers: input.passengers });
}

/** Why a vehicle can't take a cash ride now, as the same errors a scan gets. */
function assertPayable(v: FirebaseFirestore.DocumentData, driver: FirebaseFirestore.DocumentSnapshot | null, route: FirebaseFirestore.DocumentSnapshot, disabledRoutes: string[]) {
  if (v.status !== "active") fail("failed-precondition", "vehicle_inactive", "This vehicle isn't taking Konduct payments right now. Please pay in cash.");
  if (!driver?.exists || driver.get("status") !== "active" || driver.get("role") !== "driver") {
    fail("failed-precondition", "driver_inactive", "This driver isn't taking Konduct payments right now. Please pay in cash.");
  }
  if (!route.exists || route.get("active") !== true || disabledRoutes.includes(route.id)) {
    fail("failed-precondition", "route_inactive", "Konduct payments are off on this route right now. Please pay in cash.");
  }
}

export async function previewCashRide(actor: Actor, input: z.infer<typeof CashRidePreview>) {
  await rateLimit(actor.uid, "cashPreview", 30, 60_000);
  const switches = await getSwitches();
  assertOpen(switches, "payments");
  const vehicle = await findVehicle(input);
  const v = vehicle.data()!;
  const bus = countsSeats(v);
  const [driver, route, fleet, held] = await Promise.all([
    v.driverUid ? db.doc(`users/${v.driverUid}`).get() : null,
    db.doc(`routes/${v.routeId}`).get(),
    bus ? fleetRef().get() : null,
    db.doc(`wallets/${agentAccount(actor.uid)}`).get(),
  ]);
  assertPayable(v, driver, route, switches.disabledRoutes);
  const capacity = bus ? readFleet(fleet).busSeats : (v.capacity ?? RULES.maxPassengers);
  if (input.passengers > Math.min(RULES.maxPassengers, capacity)) fail("invalid-argument", "too_many", "That's more passengers than this vehicle carries.");
  const seatsTaken = bus ? (liveLoad(v)?.taken ?? 0) : 0;
  if (bus) assertSeats(capacity, seatsTaken, input.passengers);
  const fareKobo = route.get("fareKobo") as number;
  return {
    vehicleId: vehicle.id,
    plate: v.plate as string,
    vehicleType: v.type as string,
    driverFirstName: firstName(driver!.get("fullName")),
    route: route.get("name") as string,
    tripRoute: tripRouteOf(v.currentRoute),
    fareKobo,
    passengers: input.passengers,
    totalKobo: fareKobo * input.passengers,
    seatCapacity: bus ? capacity : null,
    seatsTaken,
    cashHeldKobo: (held.get("balanceKobo") as number) ?? 0,
    cashLimitKobo: RULES.maxCashHeldKobo,
  };
}

export const CashRideConfirm = z.strictObject({
  vehicleId,
  passengers: z.number().int().min(1).max(RULES.maxPassengers),
  /** The total the agent told the visitor; a fare change in between is refused, not charged. */
  totalKobo: z.number().int().positive(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

type CashRideResult = {
  txId: string;
  reference: string;
  plate: string;
  driverFirstName: string;
  route: string;
  tripRoute: { from: string; to: string; etaMin: number } | null;
  passengers: number;
  totalKobo: number;
  paidAtMs: number;
  cashHeldKobo: number;
  /** The public receipt check (receipts.ts) for the visitor's ticket. */
  verifyUrl: string | null;
};

export async function confirmCashRide(actor: Actor, input: z.infer<typeof CashRideConfirm>): Promise<CashRideResult> {
  const idemRef = db.doc(`idempotency/${sha256(`${actor.uid}|cashride|${input.idempotencyKey}`)}`);
  const earlier = await idemRef.get();
  if (earlier.exists) {
    if (earlier.get("uid") !== actor.uid) fail("permission-denied", "bad_key", "Something went wrong. Try again.");
    return earlier.get("result") as CashRideResult;
  }
  await rateLimit(actor.uid, "cashConfirm", 20, 60_000);
  assertOpen(await getSwitches(), "payments");
  await openAgentAccount(actor.uid);

  const txId = `fare_${randomId(12)}`;
  const reference = `KD-${randomCode(6)}`;
  const now = Date.now();
  const agentName = String(actor.user.fullName ?? actor.email ?? "Konduct agent");

  let driverUid = "";
  let result = await db.runTransaction(async (tx): Promise<CashRideResult> => {
    driverUid = ""; // a retried transaction starts over
    const [idem, vehicle, switchesSnap, fleet] = await tx.getAll(idemRef, db.doc(`vehicles/${input.vehicleId}`), db.doc("config/switches"), fleetRef());
    if (idem.exists) return idem.get("result") as CashRideResult;
    if (!vehicle.exists) fail("not-found", "bad_code", "No vehicle has that code. Check the sticker and try again.");
    const v = vehicle.data()!;
    if (!v.driverUid || !v.routeId) fail("failed-precondition", "driver_inactive", "This driver isn't taking Konduct payments right now. Please pay in cash.");
    const [driver, route] = await tx.getAll(db.doc(`users/${v.driverUid}`), db.doc(`routes/${v.routeId}`));
    if (switchesSnap.get("paymentsPaused")) fail("unavailable", "payments_paused", "Payments are paused for a moment. Please pay the driver in cash.");
    assertPayable(v, driver, route, (switchesSnap.get("disabledRoutes") as string[] | undefined) ?? []);
    driverUid = v.driverUid;
    const fareKobo = route.get("fareKobo") as number;
    const totalKobo = fareKobo * input.passengers;
    if (totalKobo !== input.totalKobo) fail("failed-precondition", "fare_changed", "The fare changed. Check the new price with the visitor.");

    const tripRoute = tripRouteOf(v.currentRoute);
    let load: Load | null = null;
    let newTrip = true;
    if (countsSeats(v)) {
      const current = liveLoad(v, now);
      assertSeats(readFleet(fleet).busSeats, current?.taken ?? 0, input.passengers);
      load = boarded(current, input.passengers, now);
      newTrip = current == null;
    } else if (input.passengers > Math.min(RULES.maxPassengers, (v.capacity as number | undefined) ?? RULES.maxPassengers)) {
      fail("invalid-argument", "too_many", "That's more passengers than this vehicle carries.");
    }

    const ledger = await prepare(tx, {
      txId,
      type: "fare.cash",
      legs: [
        { account: agentAccount(actor.uid), side: "debit", amountKobo: totalKobo },
        { account: driverAccount(v.driverUid), side: "credit", amountKobo: totalKobo },
      ],
      refs: { vehicleId: vehicle.id, reference, agentUid: actor.uid },
    });
    const cashHeldKobo = ledger.balance(agentAccount(actor.uid));
    if (cashHeldKobo > RULES.maxCashHeldKobo) {
      fail("failed-precondition", "cash_limit", `You're holding ${naira(cashHeldKobo - totalKobo)} in cash. Hand it in before you sell more (the limit is ${naira(RULES.maxCashHeldKobo)}).`);
    }
    ledger.commit();

    const r: CashRideResult = {
      txId,
      reference,
      plate: v.plate,
      driverFirstName: firstName(driver.get("fullName")),
      route: route.get("name"),
      tripRoute,
      passengers: input.passengers,
      totalKobo,
      paidAtMs: now,
      cashHeldKobo,
      verifyUrl: null,
    };
    tx.create(db.doc(`transactions/${txId}`), {
      type: "fare",
      channel: "cash",
      status: "completed",
      reference,
      // A visitor with no account: the agent who took the cash answers for this payment.
      payerUid: null,
      agentUid: actor.uid,
      agentName,
      driverUid: v.driverUid,
      vehicleId: vehicle.id,
      plate: v.plate,
      routeId: route.id,
      routeName: route.get("name"),
      fareVersion: route.get("fareVersion"),
      fareKobo,
      passengers: input.passengers,
      totalKobo,
      riderPaidKobo: 0,
      sponsoredKobo: 0,
      sponsor: null,
      tripStartedAtMs: load?.tripStartedAtMs ?? null,
      tripRoute,
      driverFirstName: r.driverFirstName,
      rating: null,
      createdAtMs: now,
      ...stamp(),
    });
    tx.create(db.doc(`driverFeed/${v.driverUid}/items/${txId}`), { amountKobo: totalKobo, riders: input.passengers, reference, status: "paid", via: "cash", atMs: now, ...stamp() });
    if (load) tx.update(vehicle.ref, { load });
    countFare(tx, {
      driverUid: v.driverUid,
      at: now,
      totalKobo,
      riders: input.passengers,
      newTrip,
      route: tripRoute ? `${tripRoute.from} → ${tripRoute.to}` : String(route.get("name") ?? ""),
    });
    tx.create(idemRef, { uid: actor.uid, result: r, expireAt: new Date(now + 48 * 3_600_000), ...stamp() });
    audit({ actor: actor.uid, action: "cashride.confirm", target: `transactions/${txId}`, after: { totalKobo, passengers: input.passengers, vehicleId: vehicle.id }, ip: actor.ip }, tx);
    return r;
  });
  // Another request with this key got there first and already told the driver.
  if (!driverUid) return result;

  // The ticket's QR: anyone can check it against the ledger without an account.
  const entry = await db.collection("ledgerEntries").where("txId", "==", result.txId).where("account", "==", agentAccount(actor.uid)).limit(1).get();
  if (!entry.empty) {
    result = { ...result, verifyUrl: `${publicBase()}/receipt/${result.txId}.${(entry.docs[0].get("hash") as string).slice(0, 20)}` };
    await idemRef.update({ result });
  }
  await refreshBoardQuietly(input.vehicleId);
  const riders = result.passengers === 1 ? "1 rider" : `${result.passengers} riders`;
  await notify(driverUid, "fare.received", {
    title: `${naira(result.totalKobo)} received`,
    body: `${riders} · ${result.reference} · Cash at the park`,
    data: { txId: result.txId, amountKobo: String(result.totalKobo), riders: String(result.passengers) },
    critical: true,
  });
  return result;
}

export const ReceiveCash = z.strictObject({
  /** The agent handing the cash over. */
  fromUid: z.string().regex(/^[A-Za-z0-9_-]{6,128}$/),
  amountKobo: z.number().int().positive().max(100_000_000),
  note: z.string().trim().max(200).optional(),
});

/**
 * Ops or admin took cash from an agent in person: the agent owes that much less and the person who
 * took it owes it instead, until they bank it. Recorded by the receiver, who takes on the debt.
 */
export async function receiveCash(actor: Actor, input: z.infer<typeof ReceiveCash>) {
  if (input.amountKobo % 100 !== 0) fail("invalid-argument", "whole_naira", "Enter whole naira.");
  if (input.fromUid === actor.uid) fail("invalid-argument", "same_person", "You can't hand cash to yourself.");
  await rateLimit(actor.uid, "receiveCash", 20, 60_000);
  const from = await db.doc(`wallets/${agentAccount(input.fromUid)}`).get();
  if (!from.exists) fail("not-found", "no_cash", "That person hasn't collected any cash.");
  await openAgentAccount(actor.uid);
  const txId = `cashin_${randomId(12)}`;
  try {
    return await db.runTransaction(async (tx) => {
      const ledger = await prepare(tx, {
        txId,
        type: "cash.handover",
        legs: [
          { account: agentAccount(actor.uid), side: "debit", amountKobo: input.amountKobo },
          { account: agentAccount(input.fromUid), side: "credit", amountKobo: input.amountKobo },
        ],
        memo: input.note ?? undefined,
        refs: { fromUid: input.fromUid, toUid: actor.uid },
      });
      ledger.commit();
      audit({ actor: actor.uid, action: "cash.receive", target: `wallets/${agentAccount(input.fromUid)}`, after: { amountKobo: input.amountKobo, note: input.note ?? null }, ip: actor.ip }, tx);
      return { txId, theirCashKobo: ledger.balance(agentAccount(input.fromUid)), yourCashKobo: ledger.balance(agentAccount(actor.uid)) };
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) fail("failed-precondition", "more_than_held", `They're only holding ${naira(e.balanceKobo)}.`);
    throw e;
  }
}

/** The signed-in staff member's own cash and latest sales, for the Cash rides page (agents can't read Firestore). */
export async function myCash(actor: Actor) {
  const [held, sales] = await Promise.all([
    db.doc(`wallets/${agentAccount(actor.uid)}`).get(),
    db.collection("transactions").where("agentUid", "==", actor.uid).orderBy("createdAtMs", "desc").limit(30).get(),
  ]);
  return {
    cashHeldKobo: (held.get("balanceKobo") as number) ?? 0,
    cashLimitKobo: RULES.maxCashHeldKobo,
    sales: sales.docs.map((d) => ({
      txId: d.id,
      reference: d.get("reference") as string,
      plate: d.get("plate") as string,
      passengers: d.get("passengers") as number,
      totalKobo: d.get("totalKobo") as number,
      atMs: d.get("createdAtMs") as number,
    })),
  };
}
