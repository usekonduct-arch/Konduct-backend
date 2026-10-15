/**
 * The live bus board riders see: which buses are checked in at which park, where each is going,
 * and about how many seats are left.
 *
 *   vehicles/{id}.park     where the bus is checked in (driver or staff), until it leaves, checks in
 *                          somewhere else, or RULES.parkCheckInMs passes
 *   liveBuses/{id}         a public copy of each active bus with a driver, rebuilt from the vehicle
 *                          after every change. Riders can't read vehicles (driver ids, sticker codes);
 *                          they read this. No triggers (Render only): the code that changes a vehicle
 *                          calls refreshBoard, and the server rebuilds the whole board on start.
 *
 * Seats left are an estimate: seats paid by scan on the current trip, against the bus's seats.
 * Cash riders aren't counted, so the apps say "about".
 */
import { logger } from "firebase-functions";
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { db, FieldValue, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import type { CurrentRoute } from "./landmarks";
import { countsSeats, fleetRef, liveLoad, readFleet } from "./seats";

/** vehicles/{id}.park */
export type ParkCheckIn = { id: string; name: string; atMs: number; expiresAtMs: number; by: string; byStaff: boolean };

const firstName = (full: unknown) => String(full ?? "").trim().split(/\s+/)[0] || "Driver";

/** What riders may see about one bus. Null when it shouldn't be on the board. */
export function boardEntry(
  v: FirebaseFirestore.DocumentData,
  extra: { busSeats: number; driver?: FirebaseFirestore.DocumentData; fareRoute?: FirebaseFirestore.DocumentData },
  now = Date.now(),
) {
  if (v.status !== "active" || !v.driverUid) return null;
  const bus = countsSeats(v);
  const load = liveLoad(v, now);
  const park = v.park as ParkCheckIn | undefined;
  const trip = v.currentRoute as CurrentRoute | undefined;
  const ratingCount = Number(extra.driver?.ratingCount ?? 0);
  return {
    plate: String(v.plate ?? ""),
    type: bus ? "shuttle" : "bike",
    capacity: bus ? extra.busSeats : Number(v.capacity ?? 1),
    seatsTaken: load?.taken ?? 0,
    /** seatsTaken goes back to 0 at this time unless someone else scans in. */
    seatsResetAtMs: load?.expiresAtMs ?? null,
    driverFirstName: firstName(extra.driver?.fullName),
    rating: ratingCount ? Math.round((Number(extra.driver?.ratingSum ?? 0) / ratingCount) * 10) / 10 : null,
    ratingCount,
    fareRouteId: String(v.routeId ?? ""),
    fareRouteName: String(extra.fareRoute?.name ?? ""),
    fareKobo: Number(extra.fareRoute?.fareKobo ?? 0),
    trip: trip ? { fromId: trip.fromId, fromName: trip.fromName, toId: trip.toId, toName: trip.toName, etaMin: trip.etaMin, setAtMs: trip.setAtMs } : null,
    park: park && park.expiresAtMs > now ? { id: park.id, name: park.name, atMs: park.atMs, expiresAtMs: park.expiresAtMs } : null,
    updatedAtMs: now,
  };
}

/** Rebuilds one bus's board entry from the vehicle as it is now. Safe to call any time, any number of times. */
export async function refreshBoard(vehicleId: string) {
  const boardRef = db.doc(`liveBuses/${vehicleId}`);
  await db.runTransaction(async (tx) => {
    const [v, fleet] = await tx.getAll(db.doc(`vehicles/${vehicleId}`), fleetRef());
    const data = v.data();
    const [driver, route] = data?.driverUid ? await tx.getAll(db.doc(`users/${data.driverUid}`), db.doc(`routes/${data.routeId}`)) : [];
    const entry = data ? boardEntry(data, { busSeats: readFleet(fleet).busSeats, driver: driver?.data(), fareRoute: route?.data() }) : null;
    if (entry) tx.set(boardRef, entry);
    else tx.delete(boardRef);
  });
}

/** After a change the caller already committed: the board catching up must never fail the action itself. */
export async function refreshBoardQuietly(vehicleId: string | null | undefined) {
  if (!vehicleId) return;
  await refreshBoard(vehicleId).catch((e) => logger.warn("board refresh failed", { vehicleId, err: (e as Error).message }));
}

/** Every bus (server start, seat count change, the cron job). Also removes entries for vehicles that are gone. */
export async function rebuildBoard() {
  const [vehicles, board] = await Promise.all([db.collection("vehicles").select().get(), db.collection("liveBuses").select().get()]);
  const ids = new Set(vehicles.docs.map((d) => d.id));
  for (const d of vehicles.docs) await refreshBoardQuietly(d.id);
  for (const d of board.docs) if (!ids.has(d.id)) await d.ref.delete();
  return { buses: ids.size };
}

/* ------------------------------------------------------------- check-in */

export const DriverSetPark = z.strictObject({ parkId: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/).nullable() });
export const StaffSetPark = z.strictObject({ vehicleId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/), parkId: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/).nullable() });

/**
 * Checks a bus in at a park (parkId) or out of it (null). A driver can only move their own bus;
 * staff at the park can move any bus.
 */
export async function setVehiclePark(actor: Actor, vehicleId: string | undefined, parkId: string | null) {
  const staff = actor.role !== "driver";
  await rateLimit(actor.uid, "setPark", 30, 10 * 60_000);
  if (!vehicleId) fail("failed-precondition", "no_vehicle", "Your account isn't linked to a vehicle yet. Talk to a Konduct agent.");
  const ref = db.doc(`vehicles/${vehicleId}`);
  const now = Date.now();
  const result = await db.runTransaction(async (tx) => {
    const [v, p] = await tx.getAll(ref, db.doc(`parks/${parkId ?? "_none"}`));
    if (!v.exists) fail("not-found", "no_vehicle", "Unknown vehicle.");
    if (!staff && v.get("driverUid") !== actor.uid) fail("permission-denied", "not_your_vehicle", "This vehicle isn't linked to your account.");
    if (v.get("status") !== "active") fail("failed-precondition", "vehicle_inactive", "This vehicle isn't active on Konduct.");
    const before = v.get("park") as ParkCheckIn | undefined;
    let park: ParkCheckIn | null = null;
    if (parkId) {
      if (!p.exists || p.get("active") !== true) fail("not-found", "no_park", "That park isn't on the list any more.");
      park = { id: p.id, name: String(p.get("name")), atMs: now, expiresAtMs: now + RULES.parkCheckInMs, by: actor.uid, byStaff: staff };
    }
    tx.update(ref, { park: park ?? FieldValue.delete(), ...touched() });
    audit({ actor: actor.uid, action: park ? "vehicle.park.in" : "vehicle.park.out", target: ref.path, before: before ? { park: before.name } : null, after: park ? { park: park.name } : null, ip: actor.ip }, tx);
    return park ? { parkId: park.id, parkName: park.name, expiresAtMs: park.expiresAtMs } : { parkId: null, parkName: null, expiresAtMs: null };
  });
  await refreshBoardQuietly(vehicleId);
  return result;
}
