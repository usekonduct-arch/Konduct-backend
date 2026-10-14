/**
 * Bus seats by scan. Every bus seats the same number (config/fleet, set by an admin). Each paid
 * scan adds its riders to the bus's current trip (vehicles/{id}.load), inside the payment
 * transaction, so parallel scans can never go past the seat count. Cash riders aren't counted,
 * which is why the apps show "seats left" as an estimate; the hard limit only stops the app
 * selling more seats than the bus has.
 *
 * A trip ends when the driver taps "New trip", when nobody has scanned for a while, or at the
 * latest a fixed time after its first scan (RULES.seatIdleResetMs / tripMaxMs).
 */
import type { DocumentData, DocumentSnapshot } from "firebase-admin/firestore";
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { db, FieldValue, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";

/* ---------------------------------------------------------------- fleet */

export type Fleet = { busSeats: number };
export const fleetRef = () => db.doc("config/fleet");
export const readFleet = (snap: DocumentSnapshot | null | undefined): Fleet => ({ busSeats: Number(snap?.get("busSeats")) || RULES.defaultBusSeats });

export const SetFleet = z.strictObject({ busSeats: z.number().int().min(1).max(30) });

/** Admin: how many seats every bus has. Applies to the next scan on every bus. */
export async function setFleet(actor: Actor, input: z.infer<typeof SetFleet>) {
  await db.runTransaction(async (tx) => {
    const before = readFleet(await tx.get(fleetRef()));
    tx.set(fleetRef(), { busSeats: input.busSeats, ...touched() }, { merge: true });
    audit({ actor: actor.uid, action: "fleet.set", target: "config/fleet", before, after: input, ip: actor.ip }, tx);
  });
  return input;
}

/* ----------------------------------------------------------------- load */

/** vehicles/{id}.load: seats paid by scan on the current trip. */
export type Load = { taken: number; tripStartedAtMs: number; expiresAtMs: number };

/** Seats are counted on buses only: a bike trip is one rider and over in minutes. */
export const countsSeats = (v: DocumentData | undefined) => v?.type !== "bike";

/** The current trip's load, or null when the bus is empty or its trip has ended. */
export function liveLoad(v: DocumentData | undefined, now = Date.now()): Load | null {
  const l = v?.load as Load | undefined;
  return l && l.taken > 0 && now < l.expiresAtMs ? l : null;
}

/** Refuses a scan that needs more seats than the bus has left. */
export function assertSeats(capacity: number, taken: number, passengers: number) {
  const left = Math.max(0, capacity - taken);
  if (left === 0) {
    fail("failed-precondition", "bus_full", `This bus is full on Konduct: all ${capacity} seats are paid. If riders just got off, ask the driver to tap "New trip".`, { seatsLeft: 0, capacity });
  }
  if (passengers > left) {
    fail("failed-precondition", "not_enough_seats", left === 1 ? "Only 1 seat is left on this bus." : `Only ${left} seats are left on this bus.`, { seatsLeft: left, capacity });
  }
}

/** The load after [passengers] more riders scan in at [now]. */
export function boarded(current: Load | null, passengers: number, now: number): Load {
  const tripStartedAtMs = current?.tripStartedAtMs ?? now;
  return {
    taken: (current?.taken ?? 0) + passengers,
    tripStartedAtMs,
    expiresAtMs: Math.min(now + RULES.seatIdleResetMs, tripStartedAtMs + RULES.tripMaxMs),
  };
}

/** The load after an undone payment gives its seats back, or null if that trip is already over. */
export function alighted(current: Load | null, passengers: number, paidOnTripMs: number | null | undefined): Load | null {
  if (!current || current.tripStartedAtMs !== paidOnTripMs) return null;
  return { ...current, taken: Math.max(0, current.taken - passengers) };
}

/** Driver: the bus has emptied, so the next scans start a new trip. */
export async function startNewTrip(actor: Actor) {
  await rateLimit(actor.uid, "newTrip", 20, 10 * 60_000);
  const vehicleId = actor.user.vehicleId as string | undefined;
  if (!vehicleId) fail("failed-precondition", "no_vehicle", "Your account isn't linked to a vehicle yet. Talk to a Konduct agent.");
  const ref = db.doc(`vehicles/${vehicleId}`);
  await db.runTransaction(async (tx) => {
    const v = await tx.get(ref);
    if (!v.exists || v.get("driverUid") !== actor.uid) fail("permission-denied", "not_your_vehicle", "This vehicle isn't linked to your account.");
    tx.update(ref, { load: FieldValue.delete(), ...touched() });
    audit({ actor: actor.uid, action: "vehicle.trip.new", target: ref.path, before: { seatsTaken: liveLoad(v.data())?.taken ?? 0 }, after: { seatsTaken: 0 }, ip: actor.ip }, tx);
  });
  return { seatsTaken: 0 };
}
