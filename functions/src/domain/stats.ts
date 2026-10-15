/**
 * Drivers' daily figures, for the earnings report and the monthly Wrapped in the driver app.
 *
 *   driverDays/{uid}_{YYYY-MM-DD}   one per driver per Lagos day: fares, riders, trips, money in,
 *                                   refunds out, money by hour and fares by route
 *
 * Written inside the payment (and refund) transaction, so the figures can't drift from the
 * ledger, and a month's report is at most 31 small reads. Payouts aren't here: the app reads them
 * from payouts/.
 */
import type { Transaction } from "firebase-admin/firestore";
import { logger } from "firebase-functions";

import { db, FieldValue, lagosDay, stamp } from "../lib/db";

export const driverDayRef = (uid: string, day: string) => db.doc(`driverDays/${uid}_${day}`);

/** "07" for a fare at 07:40 in Lagos. */
const lagosHour = (at: number) => String(new Date(at + 3_600_000).getUTCHours()).padStart(2, "0");

/** Route labels become map keys: keep them short and free of characters Firestore treats specially. */
const routeKey = (label: string) => label.replace(/[.`[\]*~/]/g, " ").trim().slice(0, 80) || "Unknown route";

/** One fare, counted on the driver's day. [newTrip]: it started a new trip (the bus's first scan, or any bike ride). */
export function countFare(tx: Transaction, p: { driverUid: string; at: number; totalKobo: number; riders: number; newTrip: boolean; route: string }) {
  const day = lagosDay(p.at);
  tx.set(
    driverDayRef(p.driverUid, day),
    {
      uid: p.driverUid,
      day,
      month: day.slice(0, 7),
      fares: FieldValue.increment(1),
      riders: FieldValue.increment(p.riders),
      trips: FieldValue.increment(p.newTrip ? 1 : 0),
      grossKobo: FieldValue.increment(p.totalKobo),
      byHour: { [lagosHour(p.at)]: FieldValue.increment(p.totalKobo) },
      routes: { [routeKey(p.route)]: FieldValue.increment(1) },
      lastAtMs: p.at,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** A refund the driver paid back, on the day it was refunded. */
export function countRefund(tx: Transaction, p: { driverUid: string; at: number; amountKobo: number }) {
  const day = lagosDay(p.at);
  tx.set(
    driverDayRef(p.driverUid, day),
    { uid: p.driverUid, day, month: day.slice(0, 7), refundsKobo: FieldValue.increment(p.amountKobo), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

/**
 * One-off: builds driverDays from the fares paid before these figures existed. Runs when the
 * server starts and does nothing once config/migrations says it's done.
 */
export async function backfillDriverDays() {
  const marker = db.doc("config/migrations");
  if ((await marker.get()).get("driverDaysV1")) return { skipped: true };
  type Day = { uid: string; day: string; fares: number; riders: number; trips: number; grossKobo: number; refundsKobo: number; byHour: Record<string, number>; routes: Record<string, number>; lastAtMs: number };
  const fresh = (uid: string, day: string): Day => ({ uid, day, fares: 0, riders: 0, trips: 0, grossKobo: 0, refundsKobo: 0, byHour: {}, routes: {}, lastAtMs: 0 });
  const days = new Map<string, Day>();
  const trips = new Set<string>();
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    // Ordered on one field only, so no extra index is needed; non-fares are skipped below.
    let q = db.collection("transactions").orderBy("createdAtMs").limit(500);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    for (const d of page.docs) {
      const t = d.data();
      if (t.type !== "fare" || (t.status !== "completed" && t.status !== "refunded")) continue; // undone fares never happened
      const at = Number(t.createdAtMs);
      const key = `${t.driverUid}_${lagosDay(at)}`;
      const x = days.get(key) ?? fresh(t.driverUid, lagosDay(at));
      // Old fares don't say whether they started a trip; one trip per bus per trip start, else one per fare.
      const trip = t.tripStartedAtMs ? `${t.vehicleId}_${t.tripStartedAtMs}` : d.id;
      if (!trips.has(trip)) {
        trips.add(trip);
        x.trips += 1;
      }
      x.fares += 1;
      x.riders += Number(t.passengers ?? 1);
      x.grossKobo += Number(t.totalKobo ?? 0);
      x.byHour[lagosHour(at)] = (x.byHour[lagosHour(at)] ?? 0) + Number(t.totalKobo ?? 0);
      const route = routeKey(t.tripRoute ? `${t.tripRoute.from} → ${t.tripRoute.to}` : String(t.routeName ?? ""));
      x.routes[route] = (x.routes[route] ?? 0) + 1;
      x.lastAtMs = Math.max(x.lastAtMs, at);
      days.set(key, x);
    }
    if (page.size < 500) break;
    last = page.docs[page.docs.length - 1];
  }
  // Refunds the driver covered, from their ledger entries.
  const refunds = await db.collection("ledgerEntries").where("type", "==", "refund").where("side", "==", "debit").get();
  for (const e of refunds.docs) {
    const account = String(e.get("account"));
    if (!account.startsWith("driver_")) continue;
    const uid = account.slice("driver_".length);
    const at = Number(e.get("at"));
    const key = `${uid}_${lagosDay(at)}`;
    const x = days.get(key) ?? fresh(uid, lagosDay(at));
    x.refundsKobo += Number(e.get("amountKobo"));
    days.set(key, x);
  }
  let batch = db.batch();
  let n = 0;
  for (const [key, x] of days) {
    batch.set(db.doc(`driverDays/${key}`), { ...x, month: x.day.slice(0, 7), ...stamp() });
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();
  await marker.set({ driverDaysV1: Date.now() }, { merge: true });
  logger.info("driver days backfilled", { days: days.size });
  return { days: days.size };
}
