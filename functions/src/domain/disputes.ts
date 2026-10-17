/**
 * Disputes (FR-DSP-01..03): Open -> Under review -> Resolved (refunded | rejected) -> Closed,
 * with an SLA deadline. Refunds reverse ledger entries, never edit them. Refunds above the
 * maker-checker threshold need a second staff approval.
 */
import { z } from "zod";

import { RULES } from "../config";
import { audit } from "../lib/audit";
import { db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { naira } from "../lib/money";
import { driverAccount, InsufficientFunds, type Leg, PLATFORM, prepare, riderAccount } from "../ledger/ledger";
import { requestApproval } from "./approvals";
import { notify } from "./notify";
import { countRefund } from "./stats";

export const OpenDispute = z.strictObject({
  txId: z.string().regex(/^fare_[A-Za-z0-9_-]{8,40}$/),
  reason: z.enum(["wrong_amount", "charged_twice", "driver_no_alert", "wrong_vehicle", "other"]),
  note: z.string().max(500).default(""),
});

export async function openDispute(actor: Actor, input: z.infer<typeof OpenDispute>) {
  await rateLimit(actor.uid, "dispute", 5, 24 * 3_600_000);
  const txRef = db.doc(`transactions/${input.txId}`);
  const ref = db.doc(`disputes/${input.txId}`); // one dispute per payment
  await db.runTransaction(async (tx) => {
    const [t, existing] = await tx.getAll(txRef, ref);
    if (!t.exists || t.get("payerUid") !== actor.uid) fail("not-found", "bad_tx", "We couldn't find that payment."); // BOLA-safe: same answer either way
    if (existing.exists) fail("already-exists", "dispute_exists", "You've already reported this payment. We'll update you.");
    if (Date.now() - t.get("createdAtMs") > 30 * 86_400_000) fail("failed-precondition", "too_old", "Payments older than 30 days can't be disputed in the app. Talk to support.");
    // Only what left the rider's own wallet can come back to it; a sponsor's share never does.
    const riderPaidKobo = (t.get("riderPaidKobo") as number | undefined) ?? t.get("totalKobo");
    if (riderPaidKobo <= 0) fail("failed-precondition", "nothing_paid", "A sponsor paid for this ride, so nothing left your wallet. If something went wrong, tell support.");
    tx.create(ref, {
      txId: input.txId,
      reference: t.get("reference"),
      payerUid: actor.uid,
      driverUid: t.get("driverUid"),
      totalKobo: t.get("totalKobo"),
      riderPaidKobo,
      reason: input.reason,
      messages: [{ from: "rider", text: input.note, atMs: Date.now() }],
      state: "open",
      resolution: null,
      slaDueAtMs: Date.now() + RULES.disputeSlaMs,
      ...stamp(),
    });
    audit({ actor: actor.uid, action: "dispute.open", target: ref.path, after: { reason: input.reason }, ip: actor.ip }, tx);
  });
  return { disputeId: input.txId, state: "open" };
}

export const ResolveDispute = z.strictObject({
  disputeId: z.string().regex(/^fare_[A-Za-z0-9_-]{8,40}$/),
  outcome: z.enum(["refund", "reject"]),
  amountKobo: z.number().int().positive().optional(),
  note: z.string().min(3).max(500),
});

export async function reviewDispute(actor: Actor, disputeId: string) {
  const ref = db.doc(`disputes/${disputeId}`);
  await db.runTransaction(async (tx) => {
    const d = await tx.get(ref);
    if (d.get("state") !== "open") fail("failed-precondition", "bad_state", "Only open disputes can be taken for review.");
    tx.update(ref, { state: "under_review", reviewerUid: actor.uid, ...touched() });
    audit({ actor: actor.uid, action: "dispute.review", target: ref.path, ip: actor.ip }, tx);
  });
  return { state: "under_review" };
}

export async function resolveDispute(actor: Actor, input: z.infer<typeof ResolveDispute>) {
  const ref = db.doc(`disputes/${input.disputeId}`);
  const d = await ref.get();
  if (!d.exists || d.get("state") !== "under_review") fail("failed-precondition", "bad_state", "Take the dispute for review first.");
  if (input.outcome === "reject") {
    await db.runTransaction(async (tx) => {
      tx.update(ref, { state: "resolved", resolution: { outcome: "rejected", note: input.note, byUid: actor.uid }, ...touched() });
      audit({ actor: actor.uid, action: "dispute.reject", target: ref.path, ip: actor.ip }, tx);
    });
    await notify(d.get("payerUid"), "dispute.update", { title: "Dispute reviewed", body: `We checked ${d.get("reference")}: no refund is due. Tap for details.` });
    return { state: "resolved" };
  }
  // The most a rider can get back is what they paid; a sponsor's share isn't theirs to refund.
  const refundable = (d.get("riderPaidKobo") as number | undefined) ?? d.get("totalKobo");
  const amountKobo = input.amountKobo ?? refundable;
  if (amountKobo > refundable) fail("invalid-argument", "too_much", `A refund can't be more than the rider paid (${naira(refundable)}).`);
  if (amountKobo > RULES.makerCheckerAboveKobo) {
    await ref.update({ refundRequestedKobo: amountKobo, ...touched() });
    return requestApproval({ kind: "refund", makerUid: actor.uid, target: ref.path, summary: `Refund ${naira(amountKobo)} on ${d.get("reference")}`, payload: { disputeId: input.disputeId, amountKobo } });
  }
  return executeRefund(input.disputeId, amountKobo, actor.uid, input.note);
}

/**
 * Reverses (part of) a fare: debit the driver, credit the rider. If the driver has already been
 * paid out, Konduct covers it from platform_losses rather than pushing the driver negative.
 */
export async function executeRefund(disputeId: string, amountKobo: number, byUid: string, note = "") {
  const ref = db.doc(`disputes/${disputeId}`);
  const run = (fromDriver: boolean) =>
    db.runTransaction(async (tx) => {
      const d = await tx.get(ref);
      if (d.get("state") === "resolved") return { already: true };
      const legs: Leg[] = [
        { account: fromDriver ? driverAccount(d.get("driverUid")) : PLATFORM.losses, side: "debit", amountKobo },
        { account: riderAccount(d.get("payerUid")), side: "credit", amountKobo },
      ];
      const ledger = await prepare(tx, { txId: `refund_${disputeId}`, type: "refund", legs, reversalOf: disputeId, refs: { disputeId } });
      ledger.commit();
      if (fromDriver) countRefund(tx, { driverUid: d.get("driverUid"), at: Date.now(), amountKobo });
      tx.update(ref, { state: "resolved", resolution: { outcome: "refunded", amountKobo, coveredBy: fromDriver ? "driver" : "konduct", note, byUid }, ...touched() });
      audit({ actor: byUid, action: "dispute.refund", target: ref.path, after: { amountKobo, fromDriver } }, tx);
      return { already: false, payer: d.get("payerUid") as string, reference: d.get("reference") as string };
    });
  let r;
  try {
    r = await run(true);
  } catch (e) {
    if (!(e instanceof InsufficientFunds)) throw e;
    r = await run(false);
  }
  if (!r.already && r.payer) await notify(r.payer, "dispute.update", { title: `${naira(amountKobo)} refunded`, body: `Your dispute on ${r.reference} is resolved.` });
  return { state: "resolved", refundedKobo: amountKobo };
}
