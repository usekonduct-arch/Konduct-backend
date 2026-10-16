/**
 * Invite a friend. Each rider has a referral code; a new rider enters a friend's code within
 * RULES.referralApplyWindowMs of signing up and before their first ride. When that new rider's
 * first fare goes through, both get credit, paid by Konduct from platform_promotions:
 *
 *   debit platform_promotions  bonus + welcome
 *   credit rider_<referrer>    bonus        "You earned ₦X"
 *   credit rider_<new rider>   welcome      "₦Y welcome bonus"
 *
 * The reward waits for a real fare, which the new rider can only pay with money they put in, so
 * a pile of empty sign-ups earns nothing. Each referrer is paid for at most maxPerReferrer friends.
 * The programme is off until an admin turns it on and sets the amounts (config/referrals).
 *
 *   referralCodes/{CODE}    { uid }                     the code's owner
 *   referrals/{newUid}      { referrerUid, status }     pending → rewarded | capped | off
 *   users/{uid}.referralCode, .referredBy
 */
import { logger } from "firebase-functions";
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { cleanCode, randomCode } from "../lib/crypto";
import { db, millis, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { naira } from "../lib/money";
import { PLATFORM, prepare, riderAccount, type Leg } from "../ledger/ledger";
import { notify } from "./notify";

export type ReferralConfig = { enabled: boolean; bonusKobo: number; welcomeKobo: number; maxPerReferrer: number };
const OFF: ReferralConfig = { enabled: false, bonusKobo: 0, welcomeKobo: 0, maxPerReferrer: 20 };
export const referralConfigRef = () => db.doc("config/referrals");

export async function readReferralConfig(tx?: FirebaseFirestore.Transaction): Promise<ReferralConfig> {
  const s = tx ? await tx.get(referralConfigRef()) : await referralConfigRef().get();
  return { ...OFF, ...(s.data() ?? {}) } as ReferralConfig;
}

const kobo = z.number().int().min(0).max(RULES.maxReferralBonusKobo);
export const SetReferrals = z.strictObject({
  enabled: z.boolean(),
  bonusKobo: kobo,
  welcomeKobo: kobo,
  maxPerReferrer: z.number().int().min(1).max(500),
  reason: z.string().min(5).max(200),
});

/** Admin: turn the programme on or off and set what each side gets. */
export async function setReferrals(actor: Actor, input: z.infer<typeof SetReferrals>) {
  const { reason, ...cfg } = input;
  if (cfg.enabled && cfg.bonusKobo + cfg.welcomeKobo === 0) fail("invalid-argument", "no_reward", "Set a reward for at least one side before turning referrals on.");
  await db.runTransaction(async (tx) => {
    const before = (await tx.get(referralConfigRef())).data() ?? {};
    tx.set(referralConfigRef(), { ...cfg, ...touched() }, { merge: true });
    audit({ actor: actor.uid, action: "referrals.set", target: "config/referrals", before, after: { ...cfg, reason }, ip: actor.ip }, tx);
  });
  return { ok: true };
}

/** 6 characters from the readable alphabet (no I, L, O, U), so they are easy to say and type. */
async function ensureCode(uid: string): Promise<string> {
  const userRef = db.doc(`users/${uid}`);
  return db.runTransaction(async (tx) => {
    const u = await tx.get(userRef);
    const had = u.get("referralCode") as string | undefined;
    if (had) return had;
    for (let i = 0; i < 6; i++) {
      const code = randomCode(6);
      const ref = db.doc(`referralCodes/${code}`);
      if ((await tx.get(ref)).exists) continue;
      tx.create(ref, { uid, ...stamp() });
      tx.update(userRef, { referralCode: code, ...touched() });
      return code;
    }
    throw new Error("could not allocate a referral code");
  });
}

/** The rider's invite card: their code, the current rewards and how many friends have joined. */
export async function myReferral(actor: Actor) {
  const [code, cfg, mine, applied] = await Promise.all([
    ensureCode(actor.uid),
    readReferralConfig(),
    db.collection("referrals").where("referrerUid", "==", actor.uid).get(),
    db.doc(`referrals/${actor.uid}`).get(),
  ]);
  const rewarded = mine.docs.filter((d) => d.get("status") === "rewarded");
  const createdAtMs = millis(actor.user.createdAt);
  return {
    code,
    enabled: cfg.enabled,
    bonusKobo: cfg.bonusKobo,
    welcomeKobo: cfg.welcomeKobo,
    joined: mine.size,
    rewarded: rewarded.length,
    earnedKobo: rewarded.reduce((s, d) => s + Number(d.get("bonusKobo") ?? 0), 0),
    /** This rider entered a friend's code already. */
    usedCode: applied.exists,
    /** This rider can still enter a friend's code. */
    canApply: cfg.enabled && !applied.exists && (!createdAtMs || Date.now() - createdAtMs < RULES.referralApplyWindowMs) && !(await hasRidden(actor.uid)),
  };
}

async function hasRidden(uid: string) {
  const q = await db.collection("transactions").where("payerUid", "==", uid).limit(1).get();
  return !q.empty;
}

export const ApplyReferral = z.strictObject({ code: z.string().max(16) });

/** A new rider enters a friend's code. Nothing is paid until their first fare. */
export async function applyReferral(actor: Actor, input: z.infer<typeof ApplyReferral>) {
  await rateLimit(actor.uid, "referral", 8, 3_600_000);
  const code = cleanCode(input.code);
  if (!/^[0-9A-Z]{6}$/.test(code)) fail("invalid-argument", "bad_code", "Referral codes are 6 letters and numbers.");
  const cfg = await readReferralConfig();
  if (!cfg.enabled) fail("failed-precondition", "referrals_off", "Referral rewards aren't running right now.");
  const createdAtMs = millis(actor.user.createdAt);
  if (createdAtMs && Date.now() - createdAtMs > RULES.referralApplyWindowMs) fail("failed-precondition", "too_late", "Referral codes can only be used in your first two weeks.");
  if (await hasRidden(actor.uid)) fail("failed-precondition", "already_rode", "Referral codes are for new riders, before their first ride.");

  const owner = await db.doc(`referralCodes/${code}`).get();
  if (!owner.exists) fail("not-found", "bad_code", "No one has that referral code. Check it with your friend.");
  const referrerUid = owner.get("uid") as string;
  if (referrerUid === actor.uid) fail("invalid-argument", "own_code", "That's your own code. Share it with friends instead.");

  const ref = db.doc(`referrals/${actor.uid}`);
  await db.runTransaction(async (tx) => {
    const [had, referrer] = await tx.getAll(ref, db.doc(`users/${referrerUid}`));
    if (had.exists) fail("already-exists", "already_applied", "You've already used a referral code.");
    if (referrer.get("role") !== "rider" || referrer.get("status") !== "active") fail("failed-precondition", "bad_code", "That referral code can't be used right now.");
    tx.create(ref, { referrerUid, refereeUid: actor.uid, code, status: "pending", createdAtMs: Date.now(), ...stamp() });
    tx.update(db.doc(`users/${actor.uid}`), { referredBy: referrerUid, ...touched() });
    audit({ actor: actor.uid, action: "referral.apply", target: ref.path, after: { referrerUid }, ip: actor.ip }, tx);
  });
  return { ok: true, welcomeKobo: cfg.welcomeKobo };
}

/**
 * After a fare: if this rider came with a friend's code and hasn't been rewarded yet, pay both.
 * Safe to call after every fare and twice at once: the ledger posting's id is the rider's uid.
 */
export async function rewardReferral(refereeUid: string) {
  const ref = db.doc(`referrals/${refereeUid}`);
  try {
    const pre = await ref.get();
    if (!pre.exists || pre.get("status") !== "pending") return;
    const out = await db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (r.get("status") !== "pending") return null;
      const referrerUid = r.get("referrerUid") as string;
      const cfg = await readReferralConfig(tx);
      const [referrer, referee, earlier] = await Promise.all([
        tx.get(db.doc(`users/${referrerUid}`)),
        tx.get(db.doc(`users/${refereeUid}`)),
        tx.get(db.collection("referrals").where("referrerUid", "==", referrerUid).where("status", "==", "rewarded")),
      ]);
      const capped = earlier.size >= cfg.maxPerReferrer;
      const bonus = cfg.enabled && !capped && referrer.get("status") === "active" ? cfg.bonusKobo : 0;
      const welcome = cfg.enabled ? cfg.welcomeKobo : 0;
      const legs: Leg[] = [];
      if (bonus > 0) legs.push({ account: riderAccount(referrerUid), side: "credit", amountKobo: bonus });
      if (welcome > 0) legs.push({ account: riderAccount(refereeUid), side: "credit", amountKobo: welcome });
      if (legs.length) {
        legs.push({ account: PLATFORM.promotions, side: "debit", amountKobo: bonus + welcome });
        const ledger = await prepare(tx, { txId: `referral_${refereeUid}`, type: "promo.referral", legs, refs: { referrerUid, refereeUid } });
        if (!ledger.alreadyPosted) ledger.commit();
      }
      const status = !cfg.enabled ? "off" : legs.length ? "rewarded" : "capped";
      tx.update(ref, { status, bonusKobo: bonus, welcomeKobo: welcome, rewardedAtMs: Date.now(), ...touched() });
      audit({ actor: "system:referrals", action: `referral.${status}`, target: ref.path, after: { bonus, welcome } }, tx);
      const name = String(referee.get("fullName") ?? "").trim().split(/\s+/)[0] || "Your friend";
      return { referrerUid, bonus, welcome, name };
    });
    if (!out) return;
    if (out.bonus > 0) {
      await notify(out.referrerUid, "referral.reward", { title: `You earned ${naira(out.bonus)}`, body: `${out.name} took their first Konduct ride with your code.`, data: { amountKobo: String(out.bonus) } });
    }
    if (out.welcome > 0) {
      await notify(refereeUid, "referral.welcome", { title: `${naira(out.welcome)} welcome bonus`, body: "Thanks for joining Konduct with a friend's code.", data: { amountKobo: String(out.welcome) } });
    }
  } catch (e) {
    logger.error("referral reward failed", { refereeUid, err: (e as Error).message });
  }
}
