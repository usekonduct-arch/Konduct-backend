/**
 * Wallet funding (FR-WAL-02/03, SEC-PAY-03).
 *
 * 1. Top-up: the rider picks an amount; we open a Bachs hosted checkout (NGN card or NGN bank
 *    transfer to a one-time account) carrying our own unique reference. Card data never touches
 *    Konduct (PCI scope reduction). Credit happens only from a signed webhook, and only after
 *    re-reading the checkout from the Bachs API and checking reference, currency and amount.
 *
 * 2. Deposit: a bank transfer straight to Konduct's permanent Bachs virtual account. Bachs gives
 *    one number per account, not per rider, so we match deposits by the rider's funding code in
 *    the narration, then by a sender account already linked to them. Anything else is parked in
 *    suspense for a human, never guessed.
 */
import { logger } from "firebase-functions";
import { z } from "zod";

import { RULES, TOPUP_RETURN_URL } from "../config";
import { createCheckout, getCheckout, type CheckoutSession } from "../bachs/client";
import { audit } from "../lib/audit";
import { cleanCode, sha256 } from "../lib/crypto";
import { db, FieldValue, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { naira, toDecimal, toKobo } from "../lib/money";
import { type Leg, PLATFORM, prepare, riderAccount } from "../ledger/ledger";
import { notify } from "./notify";
import { assertOpen, dailyRef, getSwitches, limitsFor, readDaily } from "./policy";

export const TopUpInput = z.strictObject({
  amountKobo: z.number().int().min(RULES.minTopUpKobo).max(RULES.maxTopUpKobo),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

export async function createTopUp(actor: Actor, input: z.infer<typeof TopUpInput>) {
  if (input.amountKobo % 100 !== 0) fail("invalid-argument", "whole_naira", "Top up in whole naira.");
  const topupId = `tu_${sha256(`${actor.uid}|${input.idempotencyKey}`).slice(0, 32)}`;
  const ref = db.doc(`topups/${topupId}`);
  const existing = await ref.get();
  if (existing.exists) {
    if (existing.get("uid") !== actor.uid) fail("permission-denied", "bad_key", "Something went wrong. Try again.");
    return { topupId, checkoutUrl: existing.get("checkoutUrl"), status: existing.get("status") };
  }

  await rateLimit(actor.uid, "topup", 6, 10 * 60_000);
  assertOpen(await getSwitches(), "funding");

  const [wallet, daily] = await Promise.all([db.doc(`wallets/${riderAccount(actor.uid)}`).get(), dailyRef(actor.uid).get()]);
  const lim = limitsFor(actor.user.kycTier);
  if ((wallet.get("balanceKobo") ?? 0) + input.amountKobo > lim.maxBalanceKobo) {
    fail("failed-precondition", "over_max_balance", `Your wallet can hold up to ${naira(lim.maxBalanceKobo)}.`);
  }
  if (readDaily(daily).fundKobo + input.amountKobo > lim.dailyFundKobo) {
    fail("failed-precondition", "over_daily_funding", `You can add up to ${naira(lim.dailyFundKobo)} a day.`);
  }

  await ref.create({ uid: actor.uid, amountKobo: input.amountKobo, status: "creating", checkoutId: null, checkoutUrl: null, ...stamp() });
  const back = (outcome: string) => `${TOPUP_RETURN_URL.value()}?topup=${topupId}&outcome=${outcome}`;
  let session: CheckoutSession;
  try {
    session = await createCheckout(
      {
        pricing: { currency: "NGN", amount: toDecimal(input.amountKobo) },
        reference: topupId,
        payment_method_types: ["NGN_CARD", "NGN_BANK_TRANSFER"],
        success_url: back("success"),
        cancel_url: back("cancel"),
        expires_in_minutes: RULES.checkoutTtlMinutes,
        customer_creation: "if_required", // never attach to a customer by an unverified email
        metadata: { topupId, kind: "wallet_topup" },
      },
      topupId,
    );
  } catch (e) {
    await ref.update({ status: "failed_to_open", ...touched() });
    fail("unavailable", "checkout_unavailable", "We couldn't open the payment page. Try again in a moment.");
  }
  await ref.update({ status: "open", checkoutId: session.checkout_id, checkoutUrl: session.checkout_url, ...touched() });
  return { topupId, checkoutUrl: session.checkout_url, status: "open" };
}

/**
 * Finds the top-up a Bachs payment belongs to. Bachs sends our reference only "when available",
 * so fall back to the metadata we attached, then to the checkout id we stored when we opened it.
 */
async function findTopUp(checkoutId: string, reference: string | null, metaTopupId?: string | null) {
  for (const id of [reference, metaTopupId]) {
    if (id?.startsWith("tu_")) {
      const snap = await db.doc(`topups/${id}`).get();
      if (snap.exists) return snap;
    }
  }
  const byCheckout = await db.collection("topups").where("checkoutId", "==", checkoutId).limit(1).get();
  return byCheckout.empty ? null : byCheckout.docs[0];
}

/**
 * From checkout.completed or collection.succeeded, the rider's pull-to-refresh, and the
 * 15-minute job. Idempotent: credits once per top-up whatever order or how many times it runs.
 * Re-reads the checkout from Bachs before crediting; the reason it did or didn't is kept on the
 * top-up (lastCheck) so a stuck one can be explained.
 */
export async function settleTopUp(checkoutId: string, reference: string | null, metaTopupId?: string | null) {
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(checkoutId)) return { handled: false as const, why: "bad checkout id" };
  const t = await findTopUp(checkoutId, reference, metaTopupId);
  if (!t) return { handled: false as const, why: "not a top-up" };
  const topupId = t.id;
  const ref = t.ref;
  if (t.get("status") === "credited") return { handled: true as const, why: "already credited" };
  if (t.get("checkoutId") && t.get("checkoutId") !== checkoutId) {
    await flag("topup_checkout_mismatch", { topupId, checkoutId });
    return { handled: false as const, why: "checkout mismatch" };
  }
  const note = (why: string) => ref.update({ lastCheck: { why, atMs: Date.now() } }).catch(() => undefined);

  // SEC-PAY-03: trust the API, not the webhook body. The checkout id is the one we stored when we
  // created this checkout, so it already ties the payment to this top-up.
  const s = await getCheckout(checkoutId);
  const status = String(s.status ?? "").toLowerCase();
  const paymentStatus = String(s.payment_status ?? "").toLowerCase();
  if (!(status === "completed" && paymentStatus === "paid")) {
    const why = `checkout ${status || "?"}/${paymentStatus || "?"}`;
    await note(why);
    return { handled: false as const, why };
  }
  // A reference or metadata Bachs does return must still be ours.
  if ((s.checkout_id && s.checkout_id !== checkoutId) || (s.reference && s.reference !== topupId) || (s.metadata?.topupId && s.metadata.topupId !== topupId)) {
    await flag("topup_reference_mismatch", { topupId, checkoutId });
    await note("reference mismatch");
    return { handled: false as const, why: "reference mismatch" };
  }
  const currency = String(s.charge?.currency ?? s.currency ?? "").toUpperCase();
  if (currency !== "NGN") {
    await flag("topup_currency_mismatch", { topupId, checkoutId, currency: currency || null });
    await note(`currency ${currency || "?"}`);
    return { handled: false as const, why: "currency" };
  }
  const paidKobo = toKobo(s.charge?.amount ?? s.amount ?? "0");
  const settledKobo = s.charge?.settlement_amount ? toKobo(s.charge.settlement_amount) : paidKobo;
  if (paidKobo <= 0 || settledKobo > paidKobo) {
    await note("bad amounts");
    return { handled: false as const, why: "bad amounts" };
  }
  if (paidKobo !== t.get("amountKobo")) await flag("topup_amount_differs", { topupId, expected: t.get("amountKobo"), paid: paidKobo });

  const uid = t.get("uid") as string;
  await creditRider({
    txId: `topup_${topupId}`,
    uid,
    paidKobo,
    settledKobo,
    type: "topup",
    refs: { topupId, checkoutId, chargeId: s.charge?.id ?? null },
    after: (tx) => tx.update(ref, { status: "credited", creditedKobo: paidKobo, chargeId: s.charge?.id ?? null, lastCheck: { why: "credited", atMs: Date.now() }, ...touched() }),
  });
  await notify(uid, "wallet.funded", { title: `${naira(paidKobo)} added`, body: "Your Konduct wallet is topped up.", data: { amountKobo: String(paidKobo) } });
  return { handled: true as const, why: "credited" };
}

/** Re-checks open top-ups with Bachs: credits the paid ones, closes the expired ones. */
async function recheck(docs: FirebaseFirestore.QueryDocumentSnapshot[]) {
  let credited = 0;
  for (const d of docs) {
    const checkoutId = d.get("checkoutId") as string | null;
    if (!checkoutId) continue;
    try {
      const r = await settleTopUp(checkoutId, d.id);
      if (r.why === "credited") credited += 1;
      else if (r.why.startsWith("checkout expired")) await expireTopUp(d.id);
    } catch (e) {
      // Bachs unreachable: the webhook, the next refresh or the next job run will settle it.
      await d.ref.update({ lastCheck: { why: `bachs unreachable: ${(e as Error).message.slice(0, 80)}`, atMs: Date.now() } }).catch(() => undefined);
    }
  }
  return credited;
}

/**
 * Every 15 minutes (with the payout check): open top-ups from the last two days are re-checked,
 * so a paid top-up lands even if Bachs's webhook never reaches us.
 */
export async function reconcileTopUps() {
  // Filtered by age here rather than in the query, so it needs no extra Firestore index.
  const since = Date.now() - 2 * 86_400_000;
  const open = await db.collection("topups").where("status", "==", "open").limit(200).get();
  const recent = open.docs.filter((d) => (d.get("createdAt")?.toMillis?.() ?? 0) >= since);
  const credited = await recheck(recent);
  if (credited) logger.info("top-ups credited by reconcile", { credited, checked: recent.length });
  return { checked: recent.length, credited };
}

/**
 * Pull-to-refresh in the rider app. A webhook can arrive late or not at all, so the rider may ask
 * us to re-read their recent open checkouts from Bachs. Same path as the webhook (settleTopUp
 * trusts only the API and credits once), so asking twice, or racing the webhook, is harmless.
 */
export async function refreshTopUps(actor: Actor) {
  await rateLimit(actor.uid, "topup_refresh", 10, 60_000);
  const open = await db.collection("topups").where("uid", "==", actor.uid).where("status", "==", "open").limit(5).get();
  const credited = await recheck(open.docs);
  return { checked: open.size, credited };
}

export async function expireTopUp(reference: string | null, checkoutId?: string | null) {
  let ref = reference?.startsWith("tu_") ? db.doc(`topups/${reference}`) : null;
  if (!ref && checkoutId) {
    const q = await db.collection("topups").where("checkoutId", "==", checkoutId).limit(1).get();
    ref = q.empty ? null : q.docs[0].ref;
  }
  if (!ref) return;
  await db.runTransaction(async (tx) => {
    const t = await tx.get(ref);
    if (t.exists && t.get("status") === "open") tx.update(ref, { status: "expired", ...touched() });
  });
}

/**
 * Posts a deposit into a rider's wallet. Konduct bears Bachs's processing fee (the rider sees
 * the full amount they sent). Over-limit deposits can't be refused (a bank transfer can't be
 * stopped), so they are credited and flagged for review.
 */
async function creditRider(p: {
  txId: string;
  uid: string;
  paidKobo: number;
  settledKobo: number;
  type: string;
  refs: Record<string, string | number | null>;
  after: (tx: FirebaseFirestore.Transaction) => void;
}) {
  const feeKobo = p.paidKobo - p.settledKobo;
  const legs: Leg[] = [
    { account: PLATFORM.bachsFloat, side: "debit", amountKobo: p.settledKobo },
    { account: riderAccount(p.uid), side: "credit", amountKobo: p.paidKobo },
  ];
  if (feeKobo > 0) legs.push({ account: PLATFORM.bachsFees, side: "debit", amountKobo: feeKobo });

  const overLimit = await db.runTransaction(async (tx) => {
    const [daily, user] = await tx.getAll(dailyRef(p.uid), db.doc(`users/${p.uid}`));
    const ledger = await prepare(tx, { txId: p.txId, type: p.type, legs, refs: p.refs });
    if (ledger.alreadyPosted) return false;
    ledger.commit();
    p.after(tx);
    tx.set(daily.ref, { uid: p.uid, fundKobo: FieldValue.increment(p.paidKobo), ...touched() }, { merge: true });
    audit({ actor: "bachs:webhook", action: `${p.type}.credit`, target: `wallets/${riderAccount(p.uid)}`, after: { amountKobo: p.paidKobo, ...p.refs } }, tx);
    const lim = limitsFor(user.get("kycTier"));
    return ledger.balance(riderAccount(p.uid)) > lim.maxBalanceKobo || readDaily(daily).fundKobo + p.paidKobo > lim.dailyFundKobo;
  });
  if (overLimit) await flag("funding_over_limit", { uid: p.uid, txId: p.txId });
}

type DepositData = {
  charge_id?: string | null;
  amount: string;
  currency: string;
  settlement_amount?: string | null;
  payment_method_details?: {
    bank_transfer?: {
      sender_name?: string | null;
      sender_bank_code?: string | null;
      sender_account_number?: string | null;
      narration?: string | null;
      session_id?: string | null;
      virtual_account?: { id?: string | null; type?: string | null } | null;
    };
  } | null;
};

const FUNDING_CODE = /KD[0-9A-Z]{6}/;

/** A transfer into Konduct's permanent virtual account (collection.succeeded, no checkout). */
export async function settleDeposit(eventId: string, d: DepositData) {
  const bt = d.payment_method_details?.bank_transfer ?? {};
  const chargeId = d.charge_id ?? `evt_${eventId}`;
  const depositRef = db.doc(`deposits/${chargeId}`);
  if ((await depositRef.get()).get("status") === "credited") return { handled: true, why: "already credited" };
  if (d.currency !== "NGN") {
    await flag("deposit_currency", { chargeId, currency: d.currency });
    return { handled: false, why: "currency" };
  }
  const paidKobo = toKobo(d.amount);
  const settledKobo = d.settlement_amount ? toKobo(d.settlement_amount) : paidKobo;
  if (settledKobo > paidKobo) return { handled: false, why: "bad amounts" };

  // Match: funding code in the narration first, then a sender account already linked to a rider.
  const narration = cleanCode(bt.narration ?? "");
  const code = FUNDING_CODE.exec(narration)?.[0];
  const senderKey = bt.sender_bank_code && bt.sender_account_number ? `${bt.sender_bank_code}_${bt.sender_account_number}` : null;
  let uid: string | null = null;
  let matchedBy: string | null = null;
  if (code) {
    const owner = await db.doc(`fundingCodes/${code}`).get();
    if (owner.exists) [uid, matchedBy] = [owner.get("uid"), "code"];
  }
  if (!uid && senderKey) {
    const payer = await db.doc(`payerAccounts/${sha256(senderKey)}`).get();
    if (payer.exists) [uid, matchedBy] = [payer.get("uid"), "sender"];
  }
  if (uid) {
    const user = await db.doc(`users/${uid}`).get();
    if (user.get("role") !== "rider" || user.get("status") !== "active") [uid, matchedBy] = [null, null];
  }

  const record = {
    chargeId,
    amountKobo: paidKobo,
    senderName: bt.sender_name ?? null,
    senderBankCode: bt.sender_bank_code ?? null,
    senderAccountLast4: bt.sender_account_number?.slice(-4) ?? null,
    sessionId: bt.session_id ?? null,
    narration: bt.narration ?? null,
  };

  if (!uid) {
    // Suspense: we hold the money, a human assigns it (deposit_assign approval).
    const legs: Leg[] = [
      { account: PLATFORM.bachsFloat, side: "debit", amountKobo: settledKobo },
      { account: PLATFORM.suspense, side: "credit", amountKobo: paidKobo },
    ];
    if (paidKobo > settledKobo) legs.push({ account: PLATFORM.bachsFees, side: "debit", amountKobo: paidKobo - settledKobo });
    await db.runTransaction(async (tx) => {
      const ledger = await prepare(tx, { txId: `deposit_${chargeId}`, type: "deposit.unmatched", legs, refs: { chargeId } });
      if (ledger.alreadyPosted) return;
      ledger.commit();
      tx.set(depositRef, { ...record, status: "unmatched", uid: null, ...stamp() });
      audit({ actor: "bachs:webhook", action: "deposit.unmatched", target: depositRef.path, after: { amountKobo: paidKobo } }, tx);
    });
    return { handled: true, why: "unmatched" };
  }

  // Remember this sender for next time, but only if no rider is linked to it yet. `create`
  // makes a race lose loudly (the transaction aborts and the webhook retries) rather than
  // re-pointing a sender to someone else.
  const payerRef = senderKey ? db.doc(`payerAccounts/${sha256(senderKey)}`) : null;
  const linkSender = Boolean(payerRef && matchedBy === "code" && !(await payerRef.get()).exists);
  await creditRider({
    txId: `deposit_${chargeId}`,
    uid,
    paidKobo,
    settledKobo,
    type: "deposit",
    refs: { chargeId, matchedBy },
    after: (tx) => {
      tx.set(depositRef, { ...record, status: "credited", uid, matchedBy, ...stamp() });
      if (linkSender && payerRef) tx.create(payerRef, { uid, firstSeenCharge: chargeId, ...stamp() });
    },
  });
  await notify(uid, "wallet.funded", { title: `${naira(paidKobo)} added`, body: "Your bank transfer has landed in your Konduct wallet.", data: { amountKobo: String(paidKobo) } });
  return { handled: true, why: `credited by ${matchedBy}` };
}

async function flag(type: string, details: Record<string, unknown>) {
  await db.collection("flags").add({ type, ...details, status: "open", ...stamp() });
}
