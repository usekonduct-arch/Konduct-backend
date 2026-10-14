/**
 * Parks: where buses wait for riders (for example Shasha park, Main Campus park). Ops add a park
 * and its location; whoever is at the park keeps its bus count current. Riders and drivers read
 * parks/{id} directly. The count is what staff last reported, not a sensor, so it carries when
 * it was set and the apps show that next to it.
 */
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";

const parkId = z.string().regex(/^[A-Za-z0-9_-]{3,40}$/);

export const UpsertPark = z
  .strictObject({
    parkId,
    name: z.string().trim().min(3).max(60),
    location: z.string().trim().min(3).max(140),
    lat: z.number().min(-90).max(90).nullable().default(null),
    lng: z.number().min(-180).max(180).nullable().default(null),
    active: z.boolean(),
  })
  .refine((p) => (p.lat == null) === (p.lng == null), "Give both latitude and longitude, or neither.");

export async function upsertPark(actor: Actor, input: z.infer<typeof UpsertPark>) {
  const { parkId: id, ...fields } = input;
  const ref = db.doc(`parks/${id}`);
  return db.runTransaction(async (tx) => {
    const p = await tx.get(ref);
    tx.set(ref, p.exists ? { ...fields, ...touched() } : { ...fields, busCount: 0, busCountAtMs: null, busCountBy: null, ...stamp() }, { merge: true });
    audit({ actor: actor.uid, action: "park.upsert", target: ref.path, before: p.exists ? { name: p.get("name"), location: p.get("location"), active: p.get("active") } : null, after: fields, ip: actor.ip }, tx);
    return { created: !p.exists };
  });
}

export const SetParkBuses = z
  .strictObject({
    parkId,
    /** The exact number of buses there now... */
    count: z.number().int().min(0).max(RULES.maxParkBuses).optional(),
    /** ...or one arrived (+1) / left (-1). */
    change: z.number().int().min(-20).max(20).optional(),
  })
  .refine((x) => (x.count == null) !== (x.change == null), "Send either a count or a change.");

export async function setParkBuses(actor: Actor, input: z.infer<typeof SetParkBuses>) {
  await rateLimit(actor.uid, "parkBuses", 60, 60_000);
  const ref = db.doc(`parks/${input.parkId}`);
  return db.runTransaction(async (tx) => {
    const p = await tx.get(ref);
    if (!p.exists) fail("not-found", "no_park", "Unknown park.");
    const before = (p.get("busCount") as number) ?? 0;
    const busCount = Math.min(RULES.maxParkBuses, Math.max(0, input.count ?? before + input.change!));
    tx.update(ref, { busCount, busCountAtMs: Date.now(), busCountBy: actor.uid, ...touched() });
    audit({ actor: actor.uid, action: "park.buses", target: ref.path, before: { busCount: before }, after: { busCount }, ip: actor.ip }, tx);
    return { busCount };
  });
}
