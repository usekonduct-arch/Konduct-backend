/**
 * Landmarks and trip routes. An admin adds the landmarks riders know (Shasha park, Main gate,
 * Senate building...) with a map pin; every park with a map pin counts as a place too. Before each trip the driver picks where the bus is going
 * from and to; staff can change it for them. The estimated time comes from the two pins, and a
 * rider can rate the driver once that time has passed (ratings.ts).
 *
 * The fare still comes from the vehicle's fare route (routes/{id}); this is where the bus is
 * actually going on this trip.
 */
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { db, FieldValue, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";

const landmarkId = z.string().regex(/^[A-Za-z0-9_-]{3,40}$/);

/** Groups on the students' campus map. */
export const PLACE_CATEGORIES = ["academic", "office", "hostel", "food", "health", "bank", "worship", "other"] as const;

export const UpsertLandmark = z.strictObject({
  landmarkId,
  name: z.string().trim().min(2).max(60),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  active: z.boolean(),
  /** Shown on the students' campus map. Separate from active, which is the drivers' list. */
  onMap: z.boolean().optional(),
  category: z.enum(PLACE_CATEGORIES).optional(),
  note: z.string().trim().max(200).optional(),
});

export async function upsertLandmark(actor: Actor, input: z.infer<typeof UpsertLandmark>) {
  const { landmarkId: id, ...fields } = input;
  const ref = db.doc(`landmarks/${id}`);
  return db.runTransaction(async (tx) => {
    const l = await tx.get(ref);
    tx.set(ref, { ...fields, ...(l.exists ? touched() : stamp()) }, { merge: true });
    audit({ actor: actor.uid, action: "landmark.upsert", target: ref.path, before: l.exists ? { name: l.get("name"), lat: l.get("lat"), lng: l.get("lng"), active: l.get("active"), onMap: l.get("onMap"), category: l.get("category"), note: l.get("note") } : null, after: fields, ip: actor.ip }, tx);
    return { created: !l.exists };
  });
}

/* ------------------------------------------------------------ estimates */

type Point = { lat: number; lng: number };

/** Straight-line distance in km (haversine). */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Road distance (straight line × RULES.roadFactor) in km, to one decimal. */
export const roadKm = (a: Point, b: Point) => Math.round(distanceKm(a, b) * RULES.roadFactor * 10) / 10;

/** Estimated minutes for a bus between two pins, stops included. The console's estimate uses the same sum. */
export function etaMinutes(a: Point, b: Point): number {
  const minutes = (distanceKm(a, b) * RULES.roadFactor) / RULES.busSpeedKmh * 60 + RULES.tripStopMinutes;
  return Math.max(RULES.minTripMinutes, Math.ceil(minutes));
}

/* ---------------------------------------------------------- trip route */

/** vehicles/{id}.currentRoute */
export type CurrentRoute = {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  etaMin: number;
  distanceKm: number;
  setAtMs: number;
  setBy: string;
  setByStaff: boolean;
};

const RouteChoice = {
  fromId: landmarkId,
  toId: landmarkId,
  /** Also clear the seats paid by scan: the bus has emptied and is starting a new trip. */
  newTrip: z.boolean().default(false),
};
const differentEnds = (x: { fromId: string; toId: string }) => x.fromId !== x.toId;
const sameEndsMessage = "Pick two different places.";

export const DriverSetRoute = z.strictObject(RouteChoice).refine(differentEnds, sameEndsMessage);
export const StaffSetRoute = z.strictObject({ vehicleId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/), ...RouteChoice }).refine(differentEnds, sameEndsMessage);

/**
 * Sets where a bus is going on this trip. A driver can only set their own bus; staff any bus.
 * Changing the route keeps the seats unless [newTrip] says the bus has emptied.
 */
export async function setVehicleRoute(actor: Actor, vehicleId: string | undefined, input: { fromId: string; toId: string; newTrip: boolean }) {
  const staff = actor.role !== "driver";
  await rateLimit(actor.uid, "setRoute", 30, 10 * 60_000);
  if (!vehicleId) fail("failed-precondition", "no_vehicle", "Your account isn't linked to a vehicle yet. Talk to a Konduct agent.");
  const ref = db.doc(`vehicles/${vehicleId}`);
  return db.runTransaction(async (tx) => {
    const [v, lFrom, lTo, pFrom, pTo] = await tx.getAll(
      ref,
      db.doc(`landmarks/${input.fromId}`),
      db.doc(`landmarks/${input.toId}`),
      db.doc(`parks/${input.fromId}`),
      db.doc(`parks/${input.toId}`),
    );
    if (!v.exists) fail("not-found", "no_vehicle", "Unknown vehicle.");
    if (!staff && v.get("driverUid") !== actor.uid) fail("permission-denied", "not_your_vehicle", "This vehicle isn't linked to your account.");
    if (v.get("status") === "retired") fail("failed-precondition", "vehicle_inactive", "This vehicle is retired.");
    // A place is a landmark, or else a park with a map pin (most trips start at a park).
    const place = (l: FirebaseFirestore.DocumentSnapshot, p: FirebaseFirestore.DocumentSnapshot) =>
      l.exists ? l : p.exists && p.get("lat") != null && p.get("lng") != null ? p : l;
    const from = place(lFrom, pFrom);
    const to = place(lTo, pTo);
    for (const l of [from, to]) if (!l.exists || l.get("active") !== true) fail("not-found", "no_landmark", "That place isn't on the list any more. Pick another.");
    const a = { lat: from.get("lat") as number, lng: from.get("lng") as number };
    const b = { lat: to.get("lat") as number, lng: to.get("lng") as number };
    const currentRoute: CurrentRoute = {
      fromId: from.id,
      fromName: from.get("name"),
      toId: to.id,
      toName: to.get("name"),
      etaMin: etaMinutes(a, b),
      distanceKm: roadKm(a, b),
      setAtMs: Date.now(),
      setBy: actor.uid,
      setByStaff: staff,
    };
    tx.update(ref, { currentRoute, ...(input.newTrip ? { load: FieldValue.delete() } : {}), ...touched() });
    const before = v.get("currentRoute") as CurrentRoute | undefined;
    audit(
      {
        actor: actor.uid,
        action: "vehicle.route",
        target: ref.path,
        before: before ? { from: before.fromName, to: before.toName } : null,
        after: { from: currentRoute.fromName, to: currentRoute.toName, etaMin: currentRoute.etaMin, newTrip: input.newTrip },
        ip: actor.ip,
      },
      tx,
    );
    return currentRoute;
  });
}
