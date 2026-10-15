/**
 * Riders rate the driver after a ride: once per paid fare, from the trip's estimated arrival
 * (transactions/{id}.rateFromMs, set at payment) until RULES.rateWindowMs after paying. The
 * rating and comment go to ratings/{txId}, which only staff read directly; the driver sees their average
 * (users/{uid}.ratingSum / ratingCount) and, through ratingFeedback, recent stars and comments
 * without who said them.
 */
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { db, FieldValue, lagosDay, stamp } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { refreshBoardQuietly } from "./board";

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
  const vehicleId = await db.runTransaction(async (tx) => {
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
    return t.get("vehicleId") as string | undefined;
  });
  await refreshBoardQuietly(vehicleId);
  return { stars: input.stars };
}

/**
 * What riders said, for the driver: their stars by count and the latest ratings with any comment.
 * Never the rider, the plate, the route or the time of day, only the Lagos date, so a comment
 * can't be traced back to one trip. Riders are told the driver won't see their name.
 */
export async function ratingFeedback(actor: Actor) {
  await rateLimit(actor.uid, "ratingFeedback", 30, 60_000);
  const recent = await db.collection("ratings").where("driverUid", "==", actor.uid).orderBy("createdAtMs", "desc").limit(RULES.feedbackShown).get();
  const user = actor.user;
  const count = Number(user.ratingCount ?? 0);
  const stars = [0, 0, 0, 0, 0];
  for (const d of recent.docs) stars[Math.min(5, Math.max(1, Number(d.get("stars")))) - 1] += 1;
  return {
    average: count ? Math.round((Number(user.ratingSum ?? 0) / count) * 10) / 10 : null,
    count,
    /** How the recent ratings split, one star to five. */
    recentStars: stars,
    recent: recent.docs.map((d) => ({
      stars: Number(d.get("stars")),
      comment: String(d.get("comment") ?? ""),
      day: lagosDay(Number(d.get("createdAtMs"))),
    })),
  };
}
