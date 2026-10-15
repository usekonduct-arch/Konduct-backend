/**
 * Support chat between riders or drivers and Konduct staff. A member opens a conversation
 * (supportThreads/{id}) about a complaint, a payment, their account or the app; staff answer
 * from the console. Messages live in supportThreads/{id}/messages. Only the server writes them;
 * the member may only mark the conversation read (firestore.rules).
 */
import { z } from "zod";

import { audit } from "../lib/audit";
import { db, FieldValue, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { notify } from "./notify";

export const SUPPORT_CATEGORIES = ["complaint", "payment", "account", "app", "other"] as const;

/** Most open conversations one person can have; they continue an existing one instead. */
const MAX_OPEN = 3;

const text = z.string().trim().min(1, "Write a message first.").max(1000, "Keep it under 1,000 characters.");
const threadId = z.string().regex(/^[A-Za-z0-9]{10,40}$/);

const preview = (s: string) => (s.length > 140 ? `${s.slice(0, 137)}…` : s);
const firstName = (full: unknown) => String(full ?? "").trim().split(/\s+/)[0] || "";

export const SupportOpen = z.strictObject({
  category: z.enum(SUPPORT_CATEGORIES),
  message: text,
  /** The payment it's about, when opened from a receipt. */
  txId: z.string().regex(/^fare_[A-Za-z0-9_-]{8,40}$/).optional(),
});

export async function openSupport(actor: Actor, input: z.infer<typeof SupportOpen>) {
  await rateLimit(actor.uid, "supportOpen", 5, 60 * 60_000);
  const ref = db.collection("supportThreads").doc();
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const open = await tx.get(db.collection("supportThreads").where("uid", "==", actor.uid).where("status", "==", "open").limit(MAX_OPEN));
    if (open.size >= MAX_OPEN) fail("resource-exhausted", "too_many_open", "You already have a few open conversations. Add to one of those and we'll answer there.");
    if (input.txId) {
      const t = await tx.get(db.doc(`transactions/${input.txId}`));
      if (!t.exists || t.get("payerUid") !== actor.uid) fail("not-found", "bad_tx", "We couldn't find that payment.");
    }
    tx.create(ref, {
      uid: actor.uid,
      role: actor.role,
      name: actor.user.fullName ?? "",
      email: actor.email,
      category: input.category,
      txId: input.txId ?? null,
      status: "open",
      lastText: preview(input.message),
      lastFrom: "member",
      lastAtMs: now,
      memberReadAtMs: now,
      messageCount: 1,
      createdAtMs: now,
      ...stamp(),
    });
    tx.create(ref.collection("messages").doc(), { from: "member", authorUid: actor.uid, authorName: firstName(actor.user.fullName), text: input.message, atMs: now, ...stamp() });
    audit({ actor: actor.uid, action: "support.open", target: ref.path, after: { category: input.category }, ip: actor.ip }, tx);
  });
  return { threadId: ref.id };
}

export const SupportSend = z.strictObject({ threadId, text });

/** The member adds to their conversation. Writing to a closed one opens it again. */
export async function sendSupport(actor: Actor, input: z.infer<typeof SupportSend>) {
  await rateLimit(actor.uid, "supportSend", 30, 10 * 60_000);
  const ref = db.doc(`supportThreads/${input.threadId}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const t = await tx.get(ref);
    if (!t.exists || t.get("uid") !== actor.uid) fail("not-found", "no_thread", "We couldn't find that conversation.");
    tx.update(ref, { status: "open", lastText: preview(input.text), lastFrom: "member", lastAtMs: now, memberReadAtMs: now, messageCount: FieldValue.increment(1), ...touched() });
    tx.create(ref.collection("messages").doc(), { from: "member", authorUid: actor.uid, authorName: firstName(actor.user.fullName), text: input.text, atMs: now, ...stamp() });
  });
  return { ok: true };
}

export const StaffSupportReply = z.strictObject({ threadId, text, close: z.boolean().default(false) });

/** Staff answer; the member gets a push. "close" marks it solved in the same step. */
export async function replySupport(actor: Actor, input: z.infer<typeof StaffSupportReply>) {
  const ref = db.doc(`supportThreads/${input.threadId}`);
  const now = Date.now();
  const uid = await db.runTransaction(async (tx) => {
    const t = await tx.get(ref);
    if (!t.exists) fail("not-found", "no_thread", "Unknown conversation.");
    tx.update(ref, {
      status: input.close ? "closed" : "open",
      lastText: preview(input.text),
      lastFrom: "staff",
      lastAtMs: now,
      lastStaffUid: actor.uid,
      messageCount: FieldValue.increment(1),
      ...touched(),
    });
    tx.create(ref.collection("messages").doc(), { from: "staff", authorUid: actor.uid, authorName: firstName(actor.user.fullName), text: input.text, atMs: now, ...stamp() });
    audit({ actor: actor.uid, action: "support.reply", target: ref.path, after: { close: input.close }, ip: actor.ip }, tx);
    return t.get("uid") as string;
  });
  await notify(uid, "support.reply", { title: "Konduct support replied", body: preview(input.text), data: { threadId: input.threadId }, channel: "konduct_default" });
  return { ok: true };
}

export const StaffSupportStatus = z.strictObject({ threadId, status: z.enum(["open", "closed"]) });

export async function setSupportStatus(actor: Actor, input: z.infer<typeof StaffSupportStatus>) {
  const ref = db.doc(`supportThreads/${input.threadId}`);
  await db.runTransaction(async (tx) => {
    const t = await tx.get(ref);
    if (!t.exists) fail("not-found", "no_thread", "Unknown conversation.");
    tx.update(ref, { status: input.status, ...touched() });
    audit({ actor: actor.uid, action: `support.${input.status}`, target: ref.path, before: { status: t.get("status") }, after: { status: input.status }, ip: actor.ip }, tx);
  });
  return { status: input.status };
}
