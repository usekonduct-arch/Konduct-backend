/**
 * Ad measurement: what sponsors are told, counted so the numbers hold up.
 *
 * The apps send batches of events (trackAds). Definitions, also shown to staff in the console:
 *   view   the ad was on screen, in the open app, for at least one second (a carousel slide that
 *          scrolls away and back counts again; a popup counts once when it opens)
 *   tap    the ad, or one of its buttons, was tapped
 *   share  a Wrapped carrying the sponsor's badge was shared
 *   reach  different people (accounts) who viewed it, ever and per day
 *
 * Accuracy rules, all enforced here rather than trusted from the phone:
 *   - only signed-in riders and drivers count, and only for ads their group can see
 *   - an event counts only if the ad existed and was scheduled at the time it happened, within
 *     the last 72 hours (phones queue events while offline)
 *   - a retried batch is ignored (each batch has an id), so a flaky network never double-counts
 *   - per person, per ad, per day: at most 20 views, 10 taps and 5 shares count, so one phone
 *     (or one person scrolling all day) can't inflate a campaign
 *
 *  adStats/{target}_{id}              totals: views, taps, shares, reach
 *  adStatsDays/{target}_{id}_{day}    per Lagos day: views, taps, shares, uniques
 *  adSeen/{target}_{id}_{uid}_{day}   one person's counts that day (for the caps and daily uniques)
 *  adReach/{target}_{id}_{uid}        exists once a person has seen it (lifetime reach)
 */
import { z } from "zod";

import { db, FieldValue, lagosDay, stamp, touched } from "../lib/db";
import { type Actor, rateLimit } from "../lib/guards";

export const CAPS = { view: 20, tap: 10, share: 5 } as const;
const MAX_AGE_MS = 72 * 3_600_000;
const SKEW_MS = 2 * 60_000;

const event = z.strictObject({
  t: z.enum(["ad", "wrapped"]),
  id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$|^\d{4}-\d{2}$/),
  k: z.enum(["view", "tap", "share"]),
  at: z.number().int().positive(),
});

export const TrackAds = z.strictObject({
  batchId: z.string().regex(/^[A-Za-z0-9_-]{12,48}$/),
  /** The phone's clock when it sent the batch: event times are shifted by its error. */
  sentAt: z.number().int().positive().optional(),
  events: z.array(event).min(1).max(60),
});

type Kind = keyof typeof CAPS;
type Target = { ok: boolean; sponsorId: string | null };

/** Whether an event's ad or Wrapped sponsorship was real, for this person's group, at that time. */
function targetFor(t: "ad" | "wrapped", snap: FirebaseFirestore.DocumentSnapshot, role: string, at: number): Target {
  if (!snap.exists) return { ok: false, sponsorId: null };
  const audience = snap.get("audience") as string;
  if (audience !== "all" && audience !== role) return { ok: false, sponsorId: null };
  if (t === "ad") {
    const starts = (snap.get("startsAtMs") as number | null) ?? 0;
    const ends = (snap.get("endsAtMs") as number | null) ?? Number.MAX_SAFE_INTEGER;
    if (at < starts - SKEW_MS || at > ends + SKEW_MS) return { ok: false, sponsorId: null };
  }
  return { ok: true, sponsorId: (snap.get("sponsorId") as string | undefined) || null };
}

export async function trackAds(actor: Actor, input: z.infer<typeof TrackAds>) {
  await rateLimit(actor.uid, "trackads", 120, 3_600_000);
  const now = Date.now();
  // A phone whose clock is wrong still counts: move its times onto the server's clock.
  const offset = input.sentAt ? now - input.sentAt : 0;
  const fresh = input.events.map((e) => ({ ...e, at: e.at + offset })).filter((e) => e.at >= now - MAX_AGE_MS && e.at <= now + SKEW_MS);

  return db.runTransaction(async (tx) => {
    const batchRef = db.doc(`adBatches/${actor.uid}_${input.batchId}`);
    if ((await tx.get(batchRef)).exists) return { counted: 0, duplicate: true };

    // Every read first (Firestore transactions): targets, then each person-day and reach doc.
    const targetKeys = [...new Set(fresh.map((e) => `${e.t}|${e.id}`))];
    const targetSnaps = targetKeys.length ? await tx.getAll(...targetKeys.map((k) => db.doc(k.startsWith("ad|") ? `ads/${k.slice(3)}` : `wrappedSponsors/${k.slice(8)}`))) : [];
    const targets = new Map(targetKeys.map((k, i) => [k, targetSnaps[i]]));

    const valid = fresh
      .map((e) => ({ e, day: lagosDay(e.at), target: targetFor(e.t, targets.get(`${e.t}|${e.id}`)!, actor.role, e.at) }))
      .filter((x) => x.target.ok);
    const seenKeys = [...new Set(valid.map((x) => `${x.e.t}_${x.e.id}_${actor.uid}_${x.day}`))];
    const reachKeys = [...new Set(valid.map((x) => `${x.e.t}_${x.e.id}_${actor.uid}`))];
    const seenSnaps = seenKeys.length ? await tx.getAll(...seenKeys.map((k) => db.doc(`adSeen/${k}`))) : [];
    const reachSnaps = reachKeys.length ? await tx.getAll(...reachKeys.map((k) => db.doc(`adReach/${k}`))) : [];
    const seen = new Map(seenKeys.map((k, i) => [k, { view: 0, tap: 0, share: 0, ...(seenSnaps[i].data() ?? {}), exists: seenSnaps[i].exists }]));
    const reached = new Map(reachKeys.map((k, i) => [k, reachSnaps[i].exists]));

    // Apply the caps in time order, adding up what each ad and each ad-day gains.
    const totals = new Map<string, { t: string; id: string; sponsorId: string | null; view: number; tap: number; share: number; reach: number }>();
    const days = new Map<string, { t: string; id: string; sponsorId: string | null; day: string; view: number; tap: number; share: number; uniques: number }>();
    let counted = 0;
    for (const { e, day, target } of valid.sort((a, b) => a.e.at - b.e.at)) {
      const sk = `${e.t}_${e.id}_${actor.uid}_${day}`;
      const s = seen.get(sk)!;
      const k = e.k as Kind;
      if ((s[k] as number) >= CAPS[k]) continue;
      s[k] = (s[k] as number) + 1;
      counted += 1;
      const key = `${e.t}_${e.id}`;
      const tot = totals.get(key) ?? { t: e.t, id: e.id, sponsorId: target.sponsorId, view: 0, tap: 0, share: 0, reach: 0 };
      const dk = `${key}_${day}`;
      const dd = days.get(dk) ?? { t: e.t, id: e.id, sponsorId: target.sponsorId, day, view: 0, tap: 0, share: 0, uniques: 0 };
      tot[k] += 1;
      dd[k] += 1;
      if (k === "view") {
        if ((s.view as number) === 1) dd.uniques += 1; // this person's first view of it that day
        const rk = `${key}_${actor.uid}`;
        if (!reached.get(rk)) {
          reached.set(rk, true);
          tot.reach += 1;
          tx.create(db.doc(`adReach/${rk}`), { target: e.t, id: e.id, uid: actor.uid, firstAtMs: e.at, ...stamp() });
        }
      }
      totals.set(key, tot);
      days.set(dk, dd);
    }

    for (const [k, s] of seen) {
      const { exists: _exists, ...counts } = s;
      tx.set(db.doc(`adSeen/${k}`), { ...counts, uid: actor.uid, ...touched() }, { merge: true });
    }
    for (const [k, v] of totals) {
      tx.set(
        db.doc(`adStats/${k}`),
        { target: v.t, id: v.id, sponsorId: v.sponsorId, views: FieldValue.increment(v.view), taps: FieldValue.increment(v.tap), shares: FieldValue.increment(v.share), reach: FieldValue.increment(v.reach), ...touched() },
        { merge: true },
      );
    }
    for (const [k, v] of days) {
      tx.set(
        db.doc(`adStatsDays/${k}`),
        { target: v.t, id: v.id, sponsorId: v.sponsorId, day: v.day, views: FieldValue.increment(v.view), taps: FieldValue.increment(v.tap), shares: FieldValue.increment(v.share), uniques: FieldValue.increment(v.uniques), ...touched() },
        { merge: true },
      );
    }
    tx.create(batchRef, { uid: actor.uid, events: input.events.length, counted, expireAt: new Date(now + 7 * 86_400_000), ...stamp() });
    return { counted, duplicate: false };
  });
}
