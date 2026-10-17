/**
 * What staff tell members, and the ads the apps show. Built for Firebase's free Spark plan:
 *
 *  Notifications  to one person: a users/{uid}/notifications doc plus a push to their phones
 *                 (notify.ts). To a group: one broadcasts/{id} doc the apps read directly (no
 *                 fan-out writes) plus one push to the group's FCM topic.
 *  Popups         a notification or ad flagged `popup` opens over the app the next time it is
 *                 open; the apps remember which they have shown.
 *  Ads            ads/{id}: carousel banners (1200×600) or popups (1080×1350), each with an
 *                 optional tap link and up to two buttons, a schedule and an on/off switch.
 *  Images         Firebase Storage needs the paid plan, so images live in media/{id} (≤700 KB,
 *                 the console resizes them first) and are served by GET /media/<id>.
 *
 * Links are https:// pages (opened in the app's web view) or app:<screen> shortcuts the apps
 * know, such as app:topup.
 */
import { randomBytes } from "node:crypto";
import { getMessaging } from "firebase-admin/messaging";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { logger } from "firebase-functions";
import { z } from "zod";

import { audit } from "../lib/audit";
import { auth, db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import type { Actor } from "../lib/guards";
import { publicBase } from "../lib/public";
import { notify } from "./notify";

/** Who a broadcast or ad is for. "one" is a single person (notifications only). */
export const AUDIENCES = ["all", "rider", "driver"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** FCM topic each member's phones join when they register (registerDevice). */
export const topicFor = (role: string) => `konduct_${role}`;

const link = z
  .string()
  .max(500)
  .refine((v) => v === "" || /^https:\/\/[^\s]+$/.test(v) || /^app:[a-z_]{2,30}$/.test(v), "Links must start with https:// or be an app: shortcut.");
const imageUrl = z
  .string()
  .max(500)
  .refine((v) => v === "" || /^https:\/\/[^\s]+$/.test(v), "Image addresses must start with https://.");
const button = z.strictObject({ label: z.string().trim().min(1).max(24), link: link.refine((v) => v !== "", "Give each button a link.") });

export const SendNotice = z.strictObject({
  audience: z.enum([...AUDIENCES, "one"]),
  /** For "one": the person's email or account ID. */
  to: z.string().trim().max(128).optional(),
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().min(2).max(600),
  imageUrl: imageUrl.optional(),
  link: link.optional(),
  linkLabel: z.string().trim().max(24).optional(),
  popup: z.boolean(),
  push: z.boolean(),
});

export const SetBroadcast = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/), active: z.boolean() });

export const UpsertAd = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
  placement: z.enum(["carousel", "popup"]),
  audience: z.enum(AUDIENCES),
  title: z.string().trim().max(80),
  body: z.string().trim().max(400),
  imageUrl: imageUrl.refine((v) => v !== "", "Every ad needs an image."),
  link: link,
  buttons: z.array(button).max(2),
  active: z.boolean(),
  startsAtMs: z.number().int().nonnegative().nullable(),
  endsAtMs: z.number().int().positive().nullable(),
  order: z.number().int().min(0).max(999),
  /** The sponsor who bought it (sponsors.ts), so its numbers land in their report. "" for house ads. */
  sponsorId: z.union([z.literal(""), z.string().regex(/^[A-Za-z0-9_-]{6,40}$/)]).default(""),
});

export const DeleteAd = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/) });

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_MEDIA_BYTES = 700 * 1024;
export const UploadMedia = z.strictObject({ contentType: z.enum(MEDIA_TYPES), data: z.string().max(Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 8) });

const newId = () => randomBytes(12).toString("base64url");

async function resolvePerson(to: string | undefined) {
  const v = (to ?? "").trim();
  if (!v) fail("invalid-argument", "no_recipient", "Enter the person's email or account ID.");
  try {
    const u = v.includes("@") ? await auth.getUserByEmail(v.toLowerCase()) : await auth.getUser(v);
    return u.uid;
  } catch {
    fail("not-found", "no_such_person", "Nobody has that email or account ID.");
  }
}

/** Sends a staff message to one person or a whole group. */
export async function sendNotice(actor: Actor, input: z.infer<typeof SendNotice>) {
  const extras = { imageUrl: input.imageUrl || null, link: input.link || null, linkLabel: input.linkLabel || null, popup: input.popup };
  const id = newId();
  const ref = db.doc(`broadcasts/${id}`);
  const base = { title: input.title, body: input.body, ...extras, push: input.push, sentBy: actor.uid, createdAtMs: Date.now(), ...stamp() };

  if (input.audience === "one") {
    const uid = await resolvePerson(input.to);
    const role = (await db.doc(`users/${uid}`).get()).get("role") as string | undefined;
    if (role !== "rider" && role !== "driver") fail("failed-precondition", "not_member", "That account isn't a rider or a driver.");
    await notify(
      uid,
      "staff.message",
      { title: input.title, body: input.body, data: { broadcastId: id }, ...extras },
      { push: input.push },
    );
    // History only: the apps read personal messages from the person's own inbox.
    await ref.set({ ...base, audience: "one", targetUid: uid, active: false });
    await audit({ actor: actor.uid, action: "notice.send.one", target: `users/${uid}`, after: { title: input.title } });
    return { id, sentTo: 1 };
  }

  await ref.set({ ...base, audience: input.audience, active: true });
  let pushed = false;
  if (input.push) pushed = await pushTopic(input.audience, { title: input.title, body: input.body, imageUrl: extras.imageUrl, data: { kind: "broadcast", broadcastId: id, link: extras.link ?? "", popup: input.popup ? "1" : "0" } });
  await ref.update({ pushed });
  await audit({ actor: actor.uid, action: `notice.send.${input.audience}`, target: ref.path, after: { title: input.title, pushed } });
  return { id, pushed };
}

async function pushTopic(audience: Audience, m: { title: string; body: string; imageUrl: string | null; data: Record<string, string> }) {
  const target =
    audience === "all" ? { condition: `'${topicFor("rider")}' in topics || '${topicFor("driver")}' in topics` } : { topic: topicFor(audience) };
  try {
    await getMessaging().send({
      ...target,
      notification: { title: m.title, body: m.body, ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}) },
      data: m.data,
      android: { priority: "high", notification: { channelId: "konduct_default", ...(m.imageUrl ? { imageUrl: m.imageUrl } : {}) } },
    });
    return true;
  } catch (e) {
    logger.warn("topic push failed", { audience, err: (e as Error).message });
    return false;
  }
}

/** Takes a group message back out of the apps' inboxes (a push already sent can't be unsent). */
export async function setBroadcastActive(actor: Actor, input: z.infer<typeof SetBroadcast>) {
  const ref = db.doc(`broadcasts/${input.id}`);
  const snap = await ref.get();
  if (!snap.exists || snap.get("audience") === "one") fail("not-found", "no_broadcast", "No such group message.");
  await ref.update({ active: input.active, ...touched() });
  await audit({ actor: actor.uid, action: input.active ? "notice.restore" : "notice.retract", target: ref.path });
  return { active: input.active };
}

export async function upsertAd(actor: Actor, input: z.infer<typeof UpsertAd>) {
  if (input.startsAtMs && input.endsAtMs && input.endsAtMs <= input.startsAtMs) fail("invalid-argument", "bad_schedule", "The end must be after the start.");
  if (input.sponsorId && !(await db.doc(`sponsors/${input.sponsorId}`).get()).exists) fail("not-found", "no_sponsor", "No such sponsor.");
  const { id: given, ...fields } = input;
  const id = given ?? newId();
  const ref = db.doc(`ads/${id}`);
  const existing = given ? await ref.get() : null;
  if (given && !existing?.exists) fail("not-found", "no_ad", "No such ad.");
  await ref.set({ ...fields, updatedBy: actor.uid, ...(existing?.exists ? touched() : { createdBy: actor.uid, ...stamp() }) }, { merge: true });
  await audit({ actor: actor.uid, action: given ? "ad.update" : "ad.create", target: ref.path, after: { placement: input.placement, audience: input.audience, active: input.active } });
  return { id };
}

export async function deleteAd(actor: Actor, input: z.infer<typeof DeleteAd>) {
  await db.doc(`ads/${input.id}`).delete();
  await audit({ actor: actor.uid, action: "ad.delete", target: `ads/${input.id}` });
  return { deleted: input.id };
}

/** Stores one image for ads and notifications; returns its public address. */
export async function uploadMedia(actor: Actor, input: z.infer<typeof UploadMedia>) {
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) fail("invalid-argument", "too_big", "Images must be under 700 KB. The console shrinks them; try a smaller picture.");
  const magic = bytes.subarray(0, 12);
  const looksRight =
    (input.contentType === "image/jpeg" && magic[0] === 0xff && magic[1] === 0xd8) ||
    (input.contentType === "image/png" && magic.subarray(0, 4).toString("hex") === "89504e47") ||
    (input.contentType === "image/webp" && magic.subarray(0, 4).toString() === "RIFF" && magic.subarray(8, 12).toString() === "WEBP");
  if (!looksRight) fail("invalid-argument", "not_an_image", "That file isn't a JPEG, PNG or WebP image.");
  const id = newId();
  await db.doc(`media/${id}`).set({ contentType: input.contentType, bytes, size: bytes.length, uploadedBy: actor.uid, ...stamp() });
  await audit({ actor: actor.uid, action: "media.upload", target: `media/${id}`, after: { size: bytes.length } });
  return { id, url: `${publicBase()}/media/${id}` };
}

/** GET /media/<id>: the stored image, cached hard (an id never changes its content). */
export async function handleMediaRequest(req: Request, res: Response) {
  const id = String(req.path ?? "").replace(/^\/(media\/)?/, "");
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return void res.status(404).send("not found");
  try {
    const snap = await db.doc(`media/${id}`).get();
    if (!snap.exists) return void res.status(404).send("not found");
    const bytes = snap.get("bytes") as Buffer | { toUint8Array?: () => Uint8Array };
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from((bytes as { toUint8Array: () => Uint8Array }).toUint8Array());
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("X-Content-Type-Options", "nosniff");
    res.status(200).type(snap.get("contentType") as string).send(body);
  } catch {
    res.status(500).send("error");
  }
}

/** Joins a phone to its member group's topic, so group messages reach it. Best effort. */
export async function joinTopic(fcmToken: string, role: string) {
  try {
    await getMessaging().subscribeToTopic([fcmToken], topicFor(role));
  } catch (e) {
    logger.warn("topic subscribe failed", { role, err: (e as Error).message });
  }
}
