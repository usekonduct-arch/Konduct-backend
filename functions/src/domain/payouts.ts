/**
 * Bank payouts through Bachs Connect (FR-DRV-03/05/06, SEC-PAY-06/07): drivers' earnings, and
 * students withdrawing their wallet balance.
 *
 * Bachs only pays out to a destination owned by the account paying, so each person is a Bachs
 * Connect *recipient* account with their own verified bank destination. A payout is:
 *
 *   reserve  (ledger)  debit their wallet    -> credit payouts-in-progress
 *   transfer (Bachs)   Konduct balance      -> their Bachs account      (amount + Bachs fee)
 *   payout   (Bachs)   their Bachs account  -> their bank               (amount)
 *   settle   (ledger)  on payout.paid: debit in-progress + fees -> credit Bachs float
 *   return   (ledger)  on failure: money comes back and the reservation is reversed
 *
 * Every Bachs write uses an idempotency key derived from the payout id; an uncertain outcome
 * (timeout/5xx) is recorded as "unknown" and resolved by reconcilePayouts, never retried blindly.
 */
import { z } from "zod";

import { DRIVER_CONTACT_EMAIL, RULES } from "../config";
import { logger } from "firebase-functions";

import { BachsError, createDestination, createPayout, createRecipientAccount, createTransfer, getBanks, getDestination, getPayout, listDestinations, type PayoutDestination, updateAccount } from "../bachs/client";
import { audit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { db, millis, stamp, touched } from "../lib/db";
import { fail, isHttpsError } from "../lib/errors";
import { type Actor, rateLimit, requireRecentSignIn } from "../lib/guards";
import { naira, toDecimal, toKobo } from "../lib/money";
import { driverAccount, InsufficientFunds, PLATFORM, prepare, riderAccount } from "../ledger/ledger";
import { checkPin } from "./accounts";
import { requestApproval } from "./approvals";
import { notify } from "./notify";
import { getSwitches } from "./policy";

/* ------------------------------------------------------------- name matching */

const tokens = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

/**
 * FR-DRV-06 tolerance rule: the bank's account name must contain at least two of the driver's
 * verified name parts (any order, ignoring titles and punctuation), or all of them if the
 * verified name has fewer than two parts.
 */
export function namesMatch(verified: string, resolved: string): boolean {
  const want = new Set(tokens(verified));
  const have = new Set(tokens(resolved));
  const hits = [...want].filter((t) => have.has(t)).length;
  return hits >= Math.min(2, want.size) && want.size > 0;
}

/* ------------------------------------------------------- bank account set-up */

export const PayoutAccountInput = z.strictObject({
  bankCode: z.string().regex(/^[0-9A-Z]{2,10}$/),
  accountNumber: z.string().regex(/^\d{10}$/, "Nigerian account numbers are 10 digits."),
  pin: z.string().max(6),
});

/**
 * FR-DRV-05: needs a fresh password sign-in (re-authentication) and the PIN. The new account goes
 * to staff approval (SEC-PAY-06) and its first payout is held 24 hours. Same for riders and drivers.
 */
export async function setPayoutAccount(actor: Actor, input: z.infer<typeof PayoutAccountInput>) {
  requireRecentSignIn(actor);
  await rateLimit(actor.uid, "payoutacct", 5, 24 * 3_600_000);
  await checkPin(actor.uid, input.pin);

  const userRef = db.doc(`users/${actor.uid}`);
  let bachsAccountId = actor.user.bachsAccountId as string | undefined;
  if (!bachsAccountId) {
    const acct = await createRecipientAccount(
      {
        contact_email: DRIVER_CONTACT_EMAIL.value().replace("{uid}", actor.uid),
        display_name: actor.user.fullName,
        country: "NG",
        entity_type: "individual",
        configuration: { recipient: { capabilities: { transfers: { requested: true }, payouts: { requested: true } } } },
      },
      // Drivers keep the key they were created with; riders get their own.
      actor.role === "driver" ? `konduct-driver-${actor.uid}` : `konduct-${actor.role}-${actor.uid}`,
    );
    bachsAccountId = acct.id;
    await db.runTransaction(async (tx) => {
      tx.set(db.doc(`connectAccounts/${acct.id}`), { uid: actor.uid, ...stamp() });
      tx.update(userRef, { bachsAccountId: acct.id, ...touched() });
    });
  }

  // Who the account belongs to (Bachs needs it before paying out). It doesn't decide the name check.
  const [first, ...rest] = String(actor.user.fullName).split(" ");
  try {
    await updateAccount(bachsAccountId, { fields: { persons: [{ first_name: first, last_name: rest.join(" ") || first, relationship: { representative: true } }] } });
  } catch (e) {
    logger.warn("bachs person update failed", { code: e instanceof BachsError ? e.code : "?", requestId: e instanceof BachsError ? e.requestId : null });
  }

  const dest = await registerDestination(actor.uid, bachsAccountId, input.bankCode, input.accountNumber);
  const resolvedName = dest.account_name ?? "";
  const match = namesMatch(actor.user.fullName, resolvedName);

  const paRef = db.collection("payoutAccounts").doc();
  await db.runTransaction(async (tx) => {
    tx.create(paRef, {
      uid: actor.uid,
      bachsAccountId,
      destinationId: dest.id,
      bankCode: input.bankCode,
      accountLast4: input.accountNumber.slice(-4), // the full number lives only at Bachs
      accountName: resolvedName,
      nameMatches: match,
      status: "pending_approval",
      holdUntilMs: Date.now() + RULES.newPayoutAccountHoldMs,
      ...stamp(),
    });
    tx.update(userRef, { pendingPayoutAccountId: paRef.id, ...touched() });
    audit({ actor: actor.uid, action: "payout_account.request", target: paRef.path, after: { bankCode: input.bankCode, last4: input.accountNumber.slice(-4), nameMatches: match }, ip: actor.ip }, tx);
  });
  await requestApproval({ kind: "payout_account", makerUid: actor.uid, target: paRef.path, summary: `${resolvedName} · ****${input.accountNumber.slice(-4)}${match ? "" : " · NAME MISMATCH"}`, payload: { payoutAccountId: paRef.id } });
  // FR-DRV-05 asks for SMS to old and new numbers; SMS goes out once a provider is chosen. Push now:
  await notify(actor.uid, "security.payout_account", { title: "New payout account requested", body: `****${input.accountNumber.slice(-4)} will be checked. Not you? Tell an agent now.`, critical: true });
  return { status: "pending_approval", accountName: resolvedName, nameMatches: match };
}

/** What Bachs said on the last bank-account attempt, kept on the profile so a failure can be explained. */
const noteBankCheck = (uid: string, check: Record<string, unknown>) =>
  db
    .doc(`users/${uid}`)
    .update({ bankCheck: { ...check, atMs: Date.now() } })
    .catch(() => undefined);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Registers the bank account at Bachs (POST /v1/payouts/destinations), which resolves the holder's
 * name at the bank. If the name isn't in the reply yet, reads the destination back a few times.
 */
async function registerDestination(uid: string, accountId: string, bankCode: string, accountNumber: string): Promise<PayoutDestination> {
  const key = `konduct-dest-${sha256(`${uid}|${bankCode}|${accountNumber}`).slice(0, 40)}`;
  let dest: PayoutDestination | undefined;
  try {
    dest = await createDestination(accountId, { type: "bank_account", currency: "NGN", bank_code: bankCode, account_number: accountNumber }, key);
  } catch (e) {
    const code = e instanceof BachsError ? e.code : "UNKNOWN";
    // Added before: it's already a destination, so find it.
    if (e instanceof BachsError && (e.status === 409 || /EXIST|DUPLICATE/.test(code))) {
      const list = await listDestinations(accountId);
      dest = (list.data ?? []).find((d) => d.account_number?.endsWith(accountNumber.slice(-4)) && d.bank_code === bankCode);
    }
    if (!dest) {
      await noteBankCheck(uid, { step: "register", code, detail: e instanceof BachsError ? e.detail.slice(0, 200) : String(e).slice(0, 200), requestId: e instanceof BachsError ? e.requestId : null });
      if (e instanceof BachsError && e.uncertain) fail("unavailable", "bank_unreachable", "We couldn't reach the bank just now. Try again in a minute.");
      if (/ROUTING|ACCOUNT_NUMBER|REJECTED|INVALID|NOT_FOUND|RESOLVE/.test(code)) {
        fail("invalid-argument", "bank_rejected", "The bank couldn't find that account. Check the bank and the 10-digit number.");
      }
      fail("failed-precondition", "bank_error", `The bank check didn't go through (${code}). Try again, or contact Konduct support.`);
    }
  }
  for (let i = 0; i < 3 && !dest.account_name && dest.id; i++) {
    await pause(1500);
    dest = await getDestination(accountId, dest.id);
  }
  await noteBankCheck(uid, { step: "registered", status: dest.status ?? null, statusReason: dest.status_reason ?? null, usable: dest.is_usable ?? null, named: Boolean(dest.account_name) });
  if (!dest.account_name) fail("unavailable", "bank_pending", "We're still confirming that account with the bank. Try again in a few minutes.");
  return dest;
}

/** Run by approvals once a second person approves the account. */
export async function activatePayoutAccount(payoutAccountId: string, approverUid: string) {
  const ref = db.doc(`payoutAccounts/${payoutAccountId}`);
  await db.runTransaction(async (tx) => {
    const pa = await tx.get(ref);
    if (!pa.exists || pa.get("status") !== "pending_approval") fail("failed-precondition", "not_pending", "This account isn't waiting for approval.");
    const userRef = db.doc(`users/${pa.get("uid")}`);
    const user = await tx.get(userRef);
    if (user.get("payoutAccountId")) tx.update(db.doc(`payoutAccounts/${user.get("payoutAccountId")}`), { status: "replaced", ...touched() });
    tx.update(ref, { status: "active", approvedBy: approverUid, approvedAtMs: Date.now(), ...touched() });
    tx.update(userRef, { payoutAccountId: payoutAccountId, pendingPayoutAccountId: null, ...touched() });
  });
}

/* ------------------------------------------------------------------ payouts */

type Trigger = "daily" | "driver_request" | "rider_request";

/** FR-DRV-03: pays a driver's whole available balance to their approved bank account. */
export const payoutDriver = (uid: string, trigger: "daily" | "driver_request") => payoutMember(uid, trigger);

/** The wallet a payout comes out of. Older payout records (before riders could withdraw) are drivers'. */
const accountOf = (p: FirebaseFirestore.DocumentData) => (p.account as string | undefined) ?? driverAccount(p.uid as string);

/**
 * Pays out to the person's approved bank account: a driver's whole balance, or the amount a rider
 * asks to withdraw. Konduct covers the Bachs payout fee either way.
 */
export async function payoutMember(uid: string, trigger: Trigger, requestedKobo?: number): Promise<{ status: string; payoutId?: string; amountKobo?: number }> {
  const sw = await getSwitches();
  if (sw.payoutsPaused || sw.payoutsHaltedByRecon) return { status: "paused" };

  const user = await db.doc(`users/${uid}`).get();
  const role = user.get("role");
  if ((role !== "driver" && role !== "rider") || user.get("status") !== "active") return { status: "driver_inactive" };
  const account = role === "rider" ? riderAccount(uid) : driverAccount(uid);
  const paId = user.get("payoutAccountId") as string | undefined;
  if (!paId) return { status: "no_payout_account" };
  const pa = await db.doc(`payoutAccounts/${paId}`).get();
  if (pa.get("status") !== "active") return { status: "payout_account_inactive" };
  if (Date.now() < pa.get("holdUntilMs")) return { status: "new_account_hold" };
  const dest = await getDestination(pa.get("bachsAccountId"), pa.get("destinationId"));
  if (!dest.is_usable) return { status: "destination_not_usable" };

  const payoutRef = db.collection("payouts").doc();
  const payoutId = payoutRef.id;
  let amountKobo = 0;
  try {
    await db.runTransaction(async (tx) => {
      const [wallet, open] = await Promise.all([
        tx.get(db.doc(`wallets/${account}`)),
        tx.get(db.collection("payouts").where("uid", "==", uid).where("status", "in", ["reserved", "transferred", "submitted", "unknown"]).limit(1)),
      ]);
      if (!open.empty) fail("failed-precondition", "payout_in_progress", "A payout is already on its way.");
      const balance = (wallet.get("balanceKobo") as number) ?? 0;
      amountKobo = requestedKobo ?? balance;
      if (amountKobo < RULES.minPayoutKobo) fail("failed-precondition", "below_minimum", `Payouts start from ${naira(RULES.minPayoutKobo)}.`);
      if (amountKobo > balance) fail("failed-precondition", "insufficient_funds", `You have ${naira(balance)} to withdraw.`);
      const ledger = await prepare(tx, {
        txId: `payout_${payoutId}`,
        type: "payout.reserve",
        legs: [
          { account, side: "debit", amountKobo },
          { account: PLATFORM.payoutsInProgress, side: "credit", amountKobo },
        ],
        refs: { payoutId },
      });
      ledger.commit();
      tx.create(payoutRef, {
        uid,
        account,
        amountKobo,
        feeKobo: RULES.payoutFeeKobo,
        method: "bank",
        trigger,
        payoutAccountId: paId,
        bachsAccountId: pa.get("bachsAccountId"),
        destinationId: pa.get("destinationId"),
        accountLast4: pa.get("accountLast4"),
        status: "reserved",
        transferId: null,
        bachsPayoutId: null,
        ...stamp(),
      });
      audit({ actor: trigger === "daily" ? "system:payout-run" : uid, action: "payout.reserve", target: payoutRef.path, after: { amountKobo } }, tx);
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) return { status: "below_minimum" };
    const why = isHttpsError(e) ? (e.details as { reason?: string })?.reason : undefined;
    if (why === "payout_in_progress" || why === "below_minimum" || why === "insufficient_funds") return { status: why };
    throw e;
  }
  await submit(payoutId);
  return { status: "submitted", payoutId, amountKobo };
}

/** Moves money at Bachs for a reserved payout. Safe to call again: every write is idempotent. */
export async function submit(payoutId: string) {
  const ref = db.doc(`payouts/${payoutId}`);
  const p = (await ref.get()).data()!;
  try {
    if (p.status === "reserved") {
      const tr = await createTransfer(
        {
          destination: p.bachsAccountId,
          amount: toDecimal(p.amountKobo + p.feeKobo), // Konduct covers the Bachs payout fee
          currency: "NGN",
          transfer_group: payoutId,
          description: String(p.account ?? "").startsWith("rider_") ? "Konduct wallet withdrawal" : "Konduct driver payout",
        },
        `payout-${payoutId}-transfer`,
      );
      await ref.update({ status: "transferred", transferId: tr.id, ...touched() });
      p.status = "transferred";
    }
    if (p.status === "transferred") {
      const po = await createPayout(p.bachsAccountId, { destination: p.destinationId, amount: toDecimal(p.amountKobo), reference: payoutId }, `payout-${payoutId}`);
      await ref.update({ status: "submitted", bachsPayoutId: po.id, ...touched() });
    }
  } catch (e) {
    if (e instanceof BachsError && !e.uncertain) {
      // Definitely refused. Before the transfer: just release. After it: pull the money back first.
      if (p.status === "transferred") await pullBack(payoutId, p);
      await release(payoutId, `bachs_${e.code}`);
    } else {
      await ref.update({ status: "unknown", lastError: e instanceof BachsError ? e.code : "error", ...touched() });
    }
  }
}

/** payout.paid / payout.failed webhooks, matched by our reference (= payout id). */
export async function onPayoutEvent(type: "payout.paid" | "payout.failed", reference: string | null, data: Record<string, unknown>) {
  if (!reference || !/^[A-Za-z0-9]{20}$/.test(reference)) return { handled: false };
  const ref = db.doc(`payouts/${reference}`);
  const p = await ref.get();
  if (!p.exists) return { handled: false };
  if (type === "payout.paid") {
    await settle(reference, data);
  } else {
    if (["paid", "returned"].includes(p.get("status"))) return { handled: true };
    await pullBack(reference, p.data()!);
    await release(reference, "bank_failed");
  }
  return { handled: true };
}

async function settle(payoutId: string, data: Record<string, unknown>) {
  const ref = db.doc(`payouts/${payoutId}`);
  const result = await db.runTransaction(async (tx) => {
    const p = await tx.get(ref);
    if (p.get("status") === "paid") return null;
    const amountKobo = p.get("amountKobo") as number;
    const feeKobo = data.withdrawal_fee ? toKobo(String(data.withdrawal_fee)) : (p.get("feeKobo") as number);
    const ledger = await prepare(tx, {
      txId: `payout_paid_${payoutId}`,
      type: "payout.paid",
      legs: [
        { account: PLATFORM.payoutsInProgress, side: "debit", amountKobo },
        { account: PLATFORM.bachsFees, side: "debit", amountKobo: feeKobo },
        { account: PLATFORM.bachsFloat, side: "credit", amountKobo: amountKobo + feeKobo },
      ],
      refs: { payoutId },
    });
    ledger.commit();
    tx.update(ref, { status: "paid", paidAtMs: Date.now(), feeKobo, ...touched() });
    audit({ actor: "bachs:webhook", action: "payout.paid", target: ref.path, after: { amountKobo } }, tx);
    return { uid: p.get("uid") as string, amountKobo, last4: p.get("accountLast4") as string };
  });
  if (result) await notify(result.uid, "payout.paid", { title: `${naira(result.amountKobo)} paid out`, body: `Sent to your bank account ****${result.last4}.`, data: { amountKobo: String(result.amountKobo) } });
}

/** Moves a transferred amount back from the driver's Bachs account to Konduct's. */
async function pullBack(payoutId: string, p: FirebaseFirestore.DocumentData) {
  if (!p.transferId) return;
  await createTransfer(
    { destination: "self", amount: toDecimal(p.amountKobo + p.feeKobo), currency: "NGN", transfer_group: payoutId, description: "Konduct payout returned" },
    `payout-${payoutId}-return`,
  ).catch(async (e) => {
    // Can't recover automatically (for example Bachs already kept a fee): a human must look.
    await db.collection("flags").add({ type: "payout_pullback_failed", payoutId, code: e instanceof BachsError ? e.code : "error", status: "open", ...stamp() });
    throw e;
  });
}

/** Gives a failed payout's reservation back to the driver's wallet. */
async function release(payoutId: string, reason: string) {
  const ref = db.doc(`payouts/${payoutId}`);
  const result = await db.runTransaction(async (tx) => {
    const p = await tx.get(ref);
    if (["paid", "returned"].includes(p.get("status"))) return null;
    const uid = p.get("uid") as string;
    const amountKobo = p.get("amountKobo") as number;
    const ledger = await prepare(tx, {
      txId: `payout_return_${payoutId}`,
      type: "payout.return",
      legs: [
        { account: PLATFORM.payoutsInProgress, side: "debit", amountKobo },
        { account: accountOf(p.data()!), side: "credit", amountKobo },
      ],
      refs: { payoutId },
      reversalOf: `payout_${payoutId}`,
    });
    ledger.commit();
    tx.update(ref, { status: "returned", failureReason: reason, ...touched() });
    audit({ actor: "system:payouts", action: "payout.returned", target: ref.path, after: { reason } }, tx);
    return { uid, amountKobo };
  });
  if (result) await notify(result.uid, "payout.failed", { title: "Payout didn't go through", body: `${naira(result.amountKobo)} is back in your Konduct wallet. Check your bank details, or talk to an agent.` });
}

/** Resolves payouts left "unknown" by a timeout, using Bachs as the source of truth. */
export async function reconcilePayouts() {
  const stuck = await db.collection("payouts").where("status", "in", ["unknown", "submitted", "transferred"]).limit(100).get();
  for (const d of stuck.docs) {
    const p = d.data();
    const ageMs = Date.now() - millis(p.updatedAt);
    if (p.status !== "unknown" && ageMs < 30 * 60_000) continue;
    try {
      if (p.bachsPayoutId) {
        const po = await getPayout(p.bachsAccountId, p.bachsPayoutId);
        if (po.status === "completed") await settle(d.id, { withdrawal_fee: po.fee });
        else if (po.status === "failed") await onPayoutEvent("payout.failed", d.id, {});
      } else {
        // Re-running submit replays the same idempotency keys: Bachs returns the original
        // result if it happened, or performs it once if it didn't.
        await d.ref.update({ status: p.transferId ? "transferred" : "reserved", ...touched() });
        await submit(d.id);
      }
    } catch {
      /* try again next run */
    }
  }
}

const PAYOUT_MESSAGES: Record<string, string> = {
    paused: "Payouts are paused for a moment. Your money is safe.",
    no_payout_account: "Add a bank account first.",
    payout_account_inactive: "Your bank account is still being checked.",
    new_account_hold: "New bank accounts wait 24 hours before the first payout, for your safety.",
    destination_not_usable: "The bank is still confirming your account. Try again later.",
    below_minimum: `Payouts start from ${naira(RULES.minPayoutKobo)}.`,
    payout_in_progress: "A payout is already on its way.",
    driver_inactive: "This account is on hold. Talk to a Konduct agent.",
    insufficient_funds: "That's more than you have in your wallet.",
};

export async function requestDriverPayout(actor: Actor, pin: string) {
  await rateLimit(actor.uid, "cashout", 3, 24 * 3_600_000);
  await checkPin(actor.uid, pin);
  const r = await payoutDriver(actor.uid, "driver_request");
  if (r.status !== "submitted") fail("failed-precondition", r.status, PAYOUT_MESSAGES[r.status] ?? "Payout isn't available right now.");
  return r;
}

export const WithdrawInput = z.strictObject({
  amountKobo: z.number().int().min(RULES.minPayoutKobo).refine((n) => n % 100 === 0, "Withdraw whole naira."),
  pin: z.string().max(6),
});

/** A student withdraws part or all of their wallet to their approved bank account. */
export async function requestRiderWithdrawal(actor: Actor, input: z.infer<typeof WithdrawInput>) {
  await rateLimit(actor.uid, "cashout", 3, 24 * 3_600_000);
  await checkPin(actor.uid, input.pin);
  const r = await payoutMember(actor.uid, "rider_request", input.amountKobo);
  if (r.status !== "submitted") fail("failed-precondition", r.status, PAYOUT_MESSAGES[r.status] ?? "Withdrawals aren't available right now.");
  return r;
}

/* -------------------------------------------------------------------- banks */

let bankCache: { at: number; banks: { code: string; name: string }[] } | null = null;

/** Nigerian banks for the account picker, from Bachs (cached for a day). */
export async function listBanks() {
  if (!bankCache || Date.now() - bankCache.at > 24 * 3_600_000) {
    const r = await getBanks("NG");
    const banks = (r.banks ?? [])
      .filter((b) => b.code && b.name)
      .map((b) => ({ code: String(b.code), name: String(b.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!banks.length) fail("unavailable", "banks_unavailable", "We couldn't load the list of banks. Try again in a moment.");
    bankCache = { at: Date.now(), banks };
  }
  return { banks: bankCache.banks };
}

