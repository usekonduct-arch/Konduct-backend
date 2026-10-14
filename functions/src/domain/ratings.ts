/**
 * Riders rate the driver after a ride: once per paid fare, from the trip's estimated arrival
 * (transactions/{id}.rateFromMs, set at payment) until RULES.rateWindowMs after paying. The
 * rating and comment go to ratings/{txId}, which only staff read; the driver sees their average
 * (users/{uid}.ratingSum / ratingCount), never who said what.
 */
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { db, FieldValue, stamp } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";

export const RateDriver = z.strictObject({
  txId: z.string().regex(/^fare_[A-Za-z0-9_-]{8,40}$/),
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(300).default(""),
});

export async function rateDriver(actor: Actor, input: z.infer<typeof RateDriver>) {
  await rateLimit(actor.uid, "rate", 10, 60_000);
  const txRef = db.doc(`transactions/${input.txId}`);
  const ratingRef = db.doc(`ratings/${input.txId}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const [t, existing] = await tx.getAll(txRef, ratingRef);
    if (!t.exists || t.get("payerUid") !== actor.uid) fail("not-found", "bad_tx", "We couldn't find that ride.");
    if (t.get("status") !== "completed") fail("failed-precondition", "not_rateable", "You can only rate rides that went ahead.");
    if (existing.exists) fail("already-exists", "already_rated", "You've already rated this ride. Thanks!");
    const from = (t.get("rateFromMs") as number | undefined) ?? (t.get("createdAtMs") as number) + RULES.rateWithoutRouteMs;
    if (now < from) fail("failed-precondition", "too_early", "You can rate this ride once you've arrived.", { rateFromMs: from });
    if (now > (t.get("createdAtMs") as number) + RULES.rateWindowMs) fail("failed-precondition", "too_late", "This ride is too old to rate.");
    const driverUid = t.get("driverUid") as string;
    tx.create(ratingRef, {
      txId: t.id,
      driverUid,
      riderUid: actor.uid,
      vehicleId: t.get("vehicleId"),
      plate: t.get("plate") ?? null,
      tripRoute: t.get("tripRoute") ?? null,
      stars: input.stars,
      comment: input.comment,
      createdAtMs: now,
      ...stamp(),
    });
    tx.update(txRef, { rating: input.stars, ratedAtMs: now });
    tx.set(db.doc(`users/${driverUid}`), { ratingSum: FieldValue.increment(input.stars), ratingCount: FieldValue.increment(1) }, { merge: true });
    audit({ actor: actor.uid, action: "driver.rate", target: ratingRef.path, after: { stars: input.stars, driverUid }, ip: actor.ip }, tx);
  });
  return { stars: input.stars };
}
