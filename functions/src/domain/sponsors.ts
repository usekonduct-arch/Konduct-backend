/**
 * Sponsors: brands that pay to reach Konduct's riders and drivers, and what they buy.
 *
 *  sponsors/{id}             name, logo and contact. Each has a ledger account sponsor_{id}: the
 *                            budget they've prepaid, which only their sponsored rides spend.
 *  rideCampaigns/{id}        sponsored rides: while one is live, the sponsor pays the rider's own
 *                            seat (friends on the same scan are paid by the rider as usual) and the
 *                            driver still receives the full fare.
 *  wrappedSponsors/{YYYY-MM} "Your month on Konduct, brought to you by …" on that month's Wrapped.
 *
 * Money in: a sponsor pays by bank transfer like anyone else. The deposit lands in suspense
 * (funding.ts) and staff assign it to the sponsor, approved by a second person (sponsor_fund), so
 * Konduct's books always match the money actually held at Bachs (recon.ts).
 *
 * Abuse limits: each campaign caps sponsored rides per rider per day and per driver per day, so a
 * rider and a driver can't drain a budget between them. Every count here is written inside the
 * same Firestore transaction as the ledger entry it describes, so reports equal the money spent.
 */
import type { Transaction } from "firebase-admin/firestore";
import { z } from "zod";

import { audit } from "../lib/audit";
import { db, FieldValue, lagosDay, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import type { Actor } from "../lib/guards";
import { naira } from "../lib/money";
import { openAccountWrite, sponsorAccount } from "../ledger/ledger";
import { requestApproval } from "./approvals";

const docId = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/);
const httpsUrl = z
  .string()
  .max(500)
  .refine((v) => v === "" || /^https:\/\/[^\s]+$/.test(v), "Addresses must start with https://.");

export const UpsertSponsor = z.strictObject({
  id: docId.optional(),
  name: z.string().trim().min(2, "Give the sponsor a name.").max(60),
  logoUrl: httpsUrl.refine((v) => v !== "", "Upload the sponsor's logo."),
  website: httpsUrl.default(""),
  contactName: z.string().trim().max(80).default(""),
  contactEmail: z.string().trim().max(120).default(""),
  contactPhone: z.string().trim().max(30).default(""),
  notes: z.string().trim().max(500).default(""),
  active: z.boolean().default(true),
});

export const FundSponsor = z.strictObject({ depositId: docId, sponsorId: docId });

export const UpsertRideCampaign = z
  .strictObject({
    id: docId.optional(),
    sponsorId: docId,
    title: z.string().trim().min(2, "Give the offer a title, like “Free rides to lectures”.").max(60),
    message: z.string().trim().max(160).default(""),
    startsAtMs: z.number().int().positive(),
    endsAtMs: z.number().int().positive(),
    /** Routes the offer covers; empty means every route. */
    routeIds: z.array(docId).max(50).default([]),
    perRiderPerDay: z.number().int().min(1).max(4),
    perDriverPerDay: z.number().int().min(1).max(300),
    /** Most this campaign may spend in total; 0 means "until the sponsor's budget runs out". */
    maxSpendKobo: z.number().int().min(0).default(0),
    active: z.boolean(),
  })
  .refine((c) => c.endsAtMs > c.startsAtMs, { message: "The offer must end after it starts.", path: ["endsAtMs"] });

export const SetWrappedSponsor = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Pick a month."),
  sponsorId: docId,
  message: z.string().trim().max(120).default(""),
  link: httpsUrl.default(""),
  audience: z.enum(["all", "rider", "driver"]),
  active: z.boolean(),
});

const newId = () => db.collection("sponsors").doc().id;

/* ------------------------------------------------------------------ sponsors */

export async function upsertSponsor(actor: Actor, input: z.infer<typeof UpsertSponsor>) {
  const { id: given, ...fields } = input;
  const id = given ?? newId();
  const ref = db.doc(`sponsors/${id}`);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (given && !existing.exists) fail("not-found", "no_sponsor", "No such sponsor.");
    // Campaigns and Wrapped show the sponsor's current name and logo.
    const [campaigns, wrapped] = existing.exists
      ? await Promise.all([tx.get(db.collection("rideCampaigns").where("sponsorId", "==", id)), tx.get(db.collection("wrappedSponsors").where("sponsorId", "==", id))])
      : [null, null];
    if (existing.exists) {
      tx.update(ref, { ...fields, updatedBy: actor.uid, ...touched() });
    } else {
      tx.create(ref, { ...fields, fundedKobo: 0, createdBy: actor.uid, ...stamp() });
      openAccountWrite(tx, sponsorAccount(id), "sponsor", null);
    }
    for (const d of [...(campaigns?.docs ?? []), ...(wrapped?.docs ?? [])]) tx.update(d.ref, { sponsorName: fields.name, logoUrl: fields.logoUrl, ...touched() });
    audit({ actor: actor.uid, action: given ? "sponsor.update" : "sponsor.create", target: ref.path, after: { name: fields.name, active: fields.active } }, tx);
  });
  return { id };
}

/**
 * Asks for an unmatched bank deposit (the sponsor's payment) to become the sponsor's budget. A
 * second staff member approves it in Approvals; then approvals.ts posts suspense → sponsor.
 */
export async function requestSponsorFunding(actor: Actor, input: z.infer<typeof FundSponsor>) {
  const [dep, sponsor] = await Promise.all([db.doc(`deposits/${input.depositId}`).get(), db.doc(`sponsors/${input.sponsorId}`).get()]);
  if (!dep.exists || dep.get("status") !== "unmatched") fail("failed-precondition", "not_unmatched", "Pick a deposit that hasn't been assigned yet.");
  if (!sponsor.exists) fail("not-found", "no_sponsor", "No such sponsor.");
  return requestApproval({
    kind: "sponsor_fund",
    makerUid: actor.uid,
    target: `deposits/${input.depositId}`,
    summary: `Add ${naira(dep.get("amountKobo"))} to ${sponsor.get("name")}'s budget`,
    payload: { depositId: input.depositId, sponsorId: input.sponsorId },
  });
}

/* --------------------------------------------------------------- ride offers */

export async function upsertRideCampaign(actor: Actor, input: z.infer<typeof UpsertRideCampaign>) {
  const sponsor = await db.doc(`sponsors/${input.sponsorId}`).get();
  if (!sponsor.exists) fail("not-found", "no_sponsor", "No such sponsor.");
  const { id: given, ...fields } = input;
  const id = given ?? newId();
  const ref = db.doc(`rideCampaigns/${id}`);
  const existing = given ? await ref.get() : null;
  if (given && !existing?.exists) fail("not-found", "no_campaign", "No such offer.");
  if (existing?.exists && existing.get("sponsorId") !== input.sponsorId) fail("failed-precondition", "sponsor_fixed", "An offer's sponsor can't change; make a new offer.");
  const snapshot = { sponsorName: sponsor.get("name"), logoUrl: sponsor.get("logoUrl") };
  if (existing?.exists) await ref.update({ ...fields, ...snapshot, updatedBy: actor.uid, ...touched() });
  else await ref.create({ ...fields, ...snapshot, rides: 0, spentKobo: 0, uniqueRiders: 0, offers: 0, createdBy: actor.uid, ...stamp() });
  await audit({ actor: actor.uid, action: given ? "campaign.update" : "campaign.create", target: ref.path, after: { title: input.title, active: input.active } });
  return { id };
}

/** What a sponsored ride covers, as stored on the quote (pay.ts). */
export type Cover = { campaignId: string; sponsorId: string; sponsorName: string; logoUrl: string; title: string; message: string; coverKobo: number };

const riderUseRef = (cid: string, uid: string, day: string) => db.doc(`campaignUse/${cid}_r_${uid}_${day}`);
const driverUseRef = (cid: string, uid: string, day: string) => db.doc(`campaignUse/${cid}_d_${uid}_${day}`);
const riderSeenRef = (cid: string, uid: string) => db.doc(`campaignRiders/${cid}_${uid}`);
const dayRef = (cid: string, day: string) => db.doc(`campaignDays/${cid}_${day}`);

type Campaign = FirebaseFirestore.DocumentData;

/** Whether a campaign covers this rider, driver and route at `now`, given its usage so far. */
function covers(c: Campaign, routeId: string, now: number, used: { rider: number; driver: number }, budgetKobo: number, fareKobo: number) {
  if (c.active !== true || now < c.startsAtMs || now >= c.endsAtMs) return false;
  if (Array.isArray(c.routeIds) && c.routeIds.length && !c.routeIds.includes(routeId)) return false;
  if (used.rider >= c.perRiderPerDay || used.driver >= c.perDriverPerDay) return false;
  if (c.maxSpendKobo > 0 && (c.spentKobo ?? 0) + fareKobo > c.maxSpendKobo) return false;
  return budgetKobo >= fareKobo;
}

/**
 * The live sponsored-ride offer for this scan, if any (payPreview). Read-only apart from the
 * "offered" counter; confirm re-checks everything inside its transaction.
 */
export async function findCover(uid: string, driverUid: string, routeId: string, fareKobo: number, now = Date.now()): Promise<Cover | null> {
  const live = await db.collection("rideCampaigns").where("active", "==", true).get();
  const candidates = live.docs.filter((d) => now >= d.get("startsAtMs") && now < d.get("endsAtMs")).sort((a, b) => a.get("startsAtMs") - b.get("startsAtMs"));
  const day = lagosDay(now);
  for (const d of candidates) {
    const c = d.data();
    const [ru, du, budget] = await db.getAll(riderUseRef(d.id, uid, day), driverUseRef(d.id, driverUid, day), db.doc(`wallets/${sponsorAccount(c.sponsorId)}`));
    const used = { rider: (ru.get("count") as number) ?? 0, driver: (du.get("count") as number) ?? 0 };
    if (!covers(c, routeId, now, used, (budget.get("balanceKobo") as number) ?? 0, fareKobo)) continue;
    await dayRef(d.id, day).set({ campaignId: d.id, sponsorId: c.sponsorId, day, offers: FieldValue.increment(1), ...touched() }, { merge: true });
    await d.ref.update({ offers: FieldValue.increment(1) });
    return { campaignId: d.id, sponsorId: c.sponsorId, sponsorName: c.sponsorName, logoUrl: c.logoUrl, title: c.title, message: c.message ?? "", coverKobo: fareKobo };
  }
  return null;
}

/**
 * Inside the payment transaction: re-checks a quoted cover against fresh state. Call before any
 * write; returns false if the offer no longer applies (ended, capped or out of budget), and a
 * `record` to call after the ledger commit, which counts the ride for the campaign's report.
 */
export async function checkCoverTx(tx: Transaction, cover: Cover, uid: string, driverUid: string, routeId: string, now: number) {
  const day = lagosDay(now);
  const [campaign, ru, du, seen, budget] = await tx.getAll(
    db.doc(`rideCampaigns/${cover.campaignId}`),
    riderUseRef(cover.campaignId, uid, day),
    driverUseRef(cover.campaignId, driverUid, day),
    riderSeenRef(cover.campaignId, uid),
    db.doc(`wallets/${sponsorAccount(cover.sponsorId)}`),
  );
  const used = { rider: (ru.get("count") as number) ?? 0, driver: (du.get("count") as number) ?? 0 };
  const ok = campaign.exists && covers(campaign.data()!, routeId, now, used, (budget.get("balanceKobo") as number) ?? 0, cover.coverKobo);
  const record = () => {
    const base = { campaignId: cover.campaignId, day, ...touched() };
    tx.set(ru.ref, { ...base, uid, count: FieldValue.increment(1) }, { merge: true });
    tx.set(du.ref, { ...base, driverUid, count: FieldValue.increment(1) }, { merge: true });
    if (!seen.exists) tx.create(seen.ref, { campaignId: cover.campaignId, uid, firstAtMs: now, ...stamp() });
    tx.set(
      dayRef(cover.campaignId, day),
      { campaignId: cover.campaignId, sponsorId: cover.sponsorId, day, rides: FieldValue.increment(1), spentKobo: FieldValue.increment(cover.coverKobo), riders: FieldValue.increment(ru.exists ? 0 : 1), ...touched() },
      { merge: true },
    );
    tx.update(campaign.ref, { rides: FieldValue.increment(1), spentKobo: FieldValue.increment(cover.coverKobo), uniqueRiders: FieldValue.increment(seen.exists ? 0 : 1), ...touched() });
  };
  return { ok, record };
}

/* ------------------------------------------------------------------- Wrapped */

export async function setWrappedSponsor(actor: Actor, input: z.infer<typeof SetWrappedSponsor>) {
  const sponsor = await db.doc(`sponsors/${input.sponsorId}`).get();
  if (!sponsor.exists) fail("not-found", "no_sponsor", "No such sponsor.");
  const ref = db.doc(`wrappedSponsors/${input.month}`);
  await ref.set(
    { month: input.month, sponsorId: input.sponsorId, sponsorName: sponsor.get("name"), logoUrl: sponsor.get("logoUrl"), message: input.message, link: input.link, audience: input.audience, active: input.active, updatedBy: actor.uid, ...touched() },
    { merge: true },
  );
  await audit({ actor: actor.uid, action: "wrapped_sponsor.set", target: ref.path, after: { sponsorId: input.sponsorId, active: input.active } });
  return { month: input.month };
}
