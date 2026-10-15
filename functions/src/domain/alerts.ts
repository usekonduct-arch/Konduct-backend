/**
 * Helpful alerts riders ask for or would want:
 *
 *  - Low balance: after a fare leaves too little for the same ride again, one push a day saying
 *    so, so the rider tops up before they're standing at the bus door.
 *  - Park watch: a rider taps "Tell me when a bus is here" on a park; the next bus that checks in
 *    there with free seats sends them a push, and the watch ends. Watches lapse after
 *    RULES.parkWatchMs so nobody gets an alert hours later.
 *
 *   parkWatches/{parkId}__{uid}   { uid, parkId, parkName, expiresAtMs }   (the rider reads their own)
 *
 * All of it is best effort: a failed alert never fails the payment or check-in that caused it.
 */
import { logger } from "firebase-functions";
import { z } from "zod";

import { RULES } from "../config";
import { db, lagosDay, stamp } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { naira } from "../lib/money";
import { notify } from "./notify";

/* ------------------------------------------------------------ low balance */

/** After a fare: if [balanceKobo] can't pay [fareKobo] again, warn the rider (once per Lagos day). */
export async function warnLowBalance(uid: string, balanceKobo: number, fareKobo: number) {
  if (fareKobo <= 0 || balanceKobo >= fareKobo) return;
  try {
    const day = lagosDay();
    const ref = db.doc(`users/${uid}`);
    const first = await db.runTransaction(async (tx) => {
      const u = await tx.get(ref);
      if (u.get("lowBalanceDay") === day) return false;
      tx.update(ref, { lowBalanceDay: day });
      return true;
    });
    if (!first) return;
    await notify(uid, "wallet.low", {
      title: "Low balance",
      body: `You have ${naira(balanceKobo)} left, not enough for another ${naira(fareKobo)} ride. Top up before your next trip.`,
      link: "app:topup",
      linkLabel: "Top up",
      data: { balanceKobo: String(balanceKobo), fareKobo: String(fareKobo) },
    });
  } catch (e) {
    logger.warn("low balance alert failed", { uid, err: (e as Error).message });
  }
}

/* ------------------------------------------------------------- park watch */

export const WatchPark = z.strictObject({ parkId: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/), on: z.boolean() });

const watchRef = (parkId: string, uid: string) => db.doc(`parkWatches/${parkId}__${uid}`);

export async function watchPark(actor: Actor, input: z.infer<typeof WatchPark>) {
  await rateLimit(actor.uid, "watchPark", 20, 10 * 60_000);
  const ref = watchRef(input.parkId, actor.uid);
  if (!input.on) {
    await ref.delete();
    return { watching: false, expiresAtMs: null };
  }
  const park = await db.doc(`parks/${input.parkId}`).get();
  if (!park.exists || park.get("active") !== true) fail("not-found", "no_park", "That park isn't on the list any more.");
  const open = await db.collection("parkWatches").where("uid", "==", actor.uid).get();
  const live = open.docs.filter((d) => d.id !== ref.id && (d.get("expiresAtMs") as number) > Date.now());
  if (live.length >= RULES.maxParkWatches) fail("resource-exhausted", "too_many_watches", `You can wait for buses at ${RULES.maxParkWatches} parks at a time.`);
  const expiresAtMs = Date.now() + RULES.parkWatchMs;
  await ref.set({ uid: actor.uid, parkId: park.id, parkName: String(park.get("name") ?? ""), expiresAtMs, expireAt: new Date(expiresAtMs + 86_400_000), ...stamp() });
  return { watching: true, expiresAtMs };
}

/**
 * A bus just checked in at [parkId]: tell everyone waiting there, if it has free seats. Reads the
 * bus's board entry, which the caller has just rebuilt.
 */
export async function alertParkWatchers(parkId: string, vehicleId: string) {
  try {
    const bus = (await db.doc(`liveBuses/${vehicleId}`).get()).data();
    if (!bus || bus.type !== "shuttle" || bus.park?.id !== parkId) return;
    const now = Date.now();
    const taken = bus.seatsResetAtMs && now < bus.seatsResetAtMs ? Number(bus.seatsTaken ?? 0) : 0;
    const free = Math.max(0, Number(bus.capacity ?? 0) - taken);
    if (free === 0) return;
    const watches = await db.collection("parkWatches").where("parkId", "==", parkId).get();
    for (const w of watches.docs) {
      // One alert per watch: delete first, so a second bus right behind doesn't alert again.
      await w.ref.delete();
      if ((w.get("expiresAtMs") as number) <= now) continue;
      const plate = String(bus.plate ?? "A bus");
      await notify(w.get("uid") as string, "park.bus", {
        title: `A bus is at ${bus.park.name}`,
        body: free === 1 ? `${plate} has about 1 seat free. Tap to see it.` : `${plate} has about ${free} seats free. Tap to see it.`,
        link: `app:buses/${parkId}`,
        data: { parkId, vehicleId, seatsFree: String(free) },
      });
    }
  } catch (e) {
    logger.warn("park watch alert failed", { parkId, vehicleId, err: (e as Error).message });
  }
}

/** Watches whose time is up. The cron job sweeps them; Firestore's TTL on expireAt is the backstop. */
export async function sweepParkWatches() {
  const old = await db.collection("parkWatches").where("expiresAtMs", "<", Date.now()).limit(400).get();
  const batch = db.batch();
  old.docs.forEach((d) => batch.delete(d.ref));
  if (!old.empty) await batch.commit();
  return { removed: old.size };
}
