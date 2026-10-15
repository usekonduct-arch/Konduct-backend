/**
 * Double-entry, append-only, hash-chained ledger (SRS 3.2 "ledger first", SRS 5 ledger rules).
 *
 *   wallets/{accountId}        one per ledger account: cached balance, seq, lastHash
 *   ledgerTx/{txId}            the transaction header, including its legs; id = idempotency
 *   ledgerEntries/{auto}       one per leg; never updated or deleted
 *
 * Balances move only inside the same Firestore transaction as their entries, so the cache can
 * always be re-derived and checked (verifyAccount). Corrections are new reversing transactions.
 *
 * Firestore transactions need every read before the first write: call `open()` after your own
 * reads and before any of your writes, then `commit()`, then write whatever else you need.
 */
import type { DocumentSnapshot, Transaction } from "firebase-admin/firestore";

import { canonical, sha256 } from "../lib/crypto";
import { db, stamp, touched } from "../lib/db";
import { isKobo } from "../lib/money";

export type Side = "debit" | "credit";
export type Leg = { account: string; side: Side; amountKobo: number };
export type AccountKind = "rider" | "driver" | "agent" | "platform";

/** Platform accounts and their normal side. Assets/expenses are debit-normal, liabilities credit-normal. */
export const PLATFORM = {
  bachsFloat: "platform_bachs_float", // asset: money held at Bachs on our balance
  bachsFees: "platform_bachs_fees", // expense: Bachs processing and payout fees
  payoutsInProgress: "platform_payouts_in_progress", // liability: reserved for a driver payout that hasn't landed
  suspense: "platform_suspense", // liability: deposits nobody has been matched to yet
  losses: "platform_losses", // expense: refunds Konduct covered
  revenue: "platform_revenue", // income: fees Konduct charges
  adjustments: "platform_adjustments", // equity: approved manual corrections
  promotions: "platform_promotions", // expense: referral rewards and other credit Konduct gives away
} as const;

const PLATFORM_NORMAL: Record<string, Side> = {
  [PLATFORM.bachsFloat]: "debit",
  [PLATFORM.bachsFees]: "debit",
  [PLATFORM.payoutsInProgress]: "credit",
  [PLATFORM.suspense]: "credit",
  [PLATFORM.losses]: "debit",
  [PLATFORM.revenue]: "credit",
  [PLATFORM.adjustments]: "debit",
  [PLATFORM.promotions]: "debit",
};

export const riderAccount = (uid: string) => `rider_${uid}`;
export const driverAccount = (uid: string) => `driver_${uid}`;
export const agentAccount = (uid: string) => `agent_${uid}`;

/** Thrown when a person's balance would go below zero (FR-WAL-05). */
export class InsufficientFunds extends Error {
  constructor(public account: string, public balanceKobo: number, public neededKobo: number) {
    super(`insufficient funds in ${account}`);
  }
}

const GENESIS = "0".repeat(64);

function entryHash(prevHash: string, e: Record<string, unknown>) {
  return sha256(prevHash + canonical(e));
}

/** Creates a person's ledger account (wallet). Safe to call twice inside or outside a transaction. */
export function openAccountWrite(tx: Transaction, accountId: string, kind: Exclude<AccountKind, "platform">, ownerUid: string) {
  tx.set(
    db.doc(`wallets/${accountId}`),
    { kind, ownerUid, normal: "credit", balanceKobo: 0, seq: 0, lastHash: GENESIS, currency: "NGN", ...stamp() },
    { merge: false },
  );
}

export type Prepared = {
  /** True when this txId was already posted: the caller should return the earlier result. */
  alreadyPosted: boolean;
  balance(account: string): number;
  commit(): void;
};

export type PostSpec = {
  txId: string;
  type: string; // "topup", "fare", "fare.undo", "payout", ...
  legs: Leg[];
  memo?: string;
  refs?: Record<string, string | number | null>;
  reversalOf?: string;
};

function validate(spec: PostSpec) {
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(spec.txId)) throw new Error(`bad txId ${spec.txId}`);
  if (spec.legs.length < 2) throw new Error("a transaction needs at least two legs");
  let dr = 0;
  let cr = 0;
  for (const l of spec.legs) {
    if (!isKobo(l.amountKobo) || l.amountKobo === 0) throw new Error(`bad leg amount ${l.amountKobo}`);
    if (l.side === "debit") dr += l.amountKobo;
    else if (l.side === "credit") cr += l.amountKobo;
    else throw new Error("bad side");
  }
  if (dr !== cr) throw new Error(`unbalanced: debits ${dr} != credits ${cr}`);
}

/**
 * Reads everything a posting needs. Throws InsufficientFunds on commit-check, before any write.
 * Call inside db.runTransaction.
 */
export async function prepare(tx: Transaction, spec: PostSpec): Promise<Prepared> {
  validate(spec);
  const headRef = db.doc(`ledgerTx/${spec.txId}`);
  const ids = [...new Set(spec.legs.map((l) => l.account))];
  const [head, ...snaps] = await tx.getAll(headRef, ...ids.map((id) => db.doc(`wallets/${id}`)));
  const byId = new Map<string, DocumentSnapshot>(ids.map((id, i) => [id, snaps[i]]));

  if (head.exists) {
    return { alreadyPosted: true, balance: (a) => (byId.get(a)?.get("balanceKobo") as number) ?? 0, commit: () => undefined };
  }

  // Work out every new balance before writing anything.
  const state = new Map<string, { exists: boolean; normal: Side; kind: AccountKind; balance: number; seq: number; lastHash: string; ownerUid: string | null }>();
  for (const id of ids) {
    const s = byId.get(id)!;
    if (s.exists) {
      state.set(id, {
        exists: true,
        normal: s.get("normal"),
        kind: s.get("kind"),
        balance: s.get("balanceKobo"),
        seq: s.get("seq"),
        lastHash: s.get("lastHash"),
        ownerUid: s.get("ownerUid") ?? null,
      });
    } else if (PLATFORM_NORMAL[id]) {
      state.set(id, { exists: false, normal: PLATFORM_NORMAL[id], kind: "platform", balance: 0, seq: 0, lastHash: GENESIS, ownerUid: null });
    } else {
      throw new Error(`ledger account ${id} is not open`);
    }
  }

  const at = Date.now();
  const entries: { id: string; data: Record<string, unknown> }[] = [];
  for (const leg of spec.legs) {
    const a = state.get(leg.account)!;
    const delta = leg.side === a.normal ? leg.amountKobo : -leg.amountKobo;
    const after = a.balance + delta;
    if (a.kind !== "platform" && after < 0) throw new InsufficientFunds(leg.account, a.balance, leg.amountKobo);
    const seq = a.seq + 1;
    const body = { txId: spec.txId, account: leg.account, side: leg.side, amountKobo: leg.amountKobo, balanceAfterKobo: after, seq, type: spec.type, at };
    const hash = entryHash(a.lastHash, body);
    entries.push({ id: `${leg.account}__${String(seq).padStart(10, "0")}`, data: { ...body, prevHash: a.lastHash, hash, ownerUid: a.ownerUid } });
    Object.assign(a, { balance: after, seq, lastHash: hash });
  }

  return {
    alreadyPosted: false,
    balance: (acct) => state.get(acct)?.balance ?? 0,
    commit() {
      tx.create(headRef, {
        type: spec.type,
        legs: spec.legs,
        memo: spec.memo ?? null,
        refs: spec.refs ?? {},
        reversalOf: spec.reversalOf ?? null,
        reversedBy: null,
        at,
        ...stamp(),
      });
      // Entry ids are account + seq: two racing postings on one account collide on create
      // and the losing transaction retries against fresh state.
      for (const e of entries) tx.create(db.doc(`ledgerEntries/${e.id}`), e.data);
      for (const [id, a] of state) {
        const ref = db.doc(`wallets/${id}`);
        if (a.exists) tx.update(ref, { balanceKobo: a.balance, seq: a.seq, lastHash: a.lastHash, ...touched() });
        else tx.set(ref, { kind: "platform", ownerUid: null, normal: a.normal, balanceKobo: a.balance, seq: a.seq, lastHash: a.lastHash, currency: "NGN", ...stamp() });
      }
    },
  };
}

/** Builds the mirror-image legs of an earlier transaction, for refunds and undo (FR-DSP-03). */
export async function reversalLegs(tx: Transaction, originalTxId: string, amountKobo?: number): Promise<{ legs: Leg[]; type: string }> {
  const head = await tx.get(db.doc(`ledgerTx/${originalTxId}`));
  if (!head.exists) throw new Error(`no ledger transaction ${originalTxId}`);
  if (head.get("reversedBy")) throw new Error(`${originalTxId} is already reversed`);
  const legs = head.get("legs") as Leg[];
  const total = legs.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountKobo, 0);
  if (amountKobo !== undefined && (amountKobo <= 0 || amountKobo > total)) throw new Error("bad partial reversal amount");
  if (amountKobo !== undefined && amountKobo !== total && legs.length !== 2) throw new Error("partial reversal needs a two-leg original");
  return {
    type: head.get("type"),
    legs: legs.map((l) => ({ account: l.account, side: l.side === "debit" ? "credit" : "debit", amountKobo: amountKobo ?? l.amountKobo })),
  };
}

export function markReversed(tx: Transaction, originalTxId: string, reversalTxId: string) {
  tx.update(db.doc(`ledgerTx/${originalTxId}`), { reversedBy: reversalTxId, ...touched() });
}

/**
 * Re-derives an account from its entries: every hash must chain and the final balance must
 * equal the cached one. Used by the nightly integrity job (SRS 5, NFR "verifiable").
 */
export async function verifyAccount(accountId: string): Promise<{ ok: boolean; problem?: string; entries: number }> {
  const acct = await db.doc(`wallets/${accountId}`).get();
  if (!acct.exists) return { ok: false, problem: "missing account", entries: 0 };
  const normal = acct.get("normal") as Side;
  let prev = GENESIS;
  let balance = 0;
  let seq = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection("ledgerEntries").where("account", "==", accountId).orderBy("seq").limit(500);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    for (const d of page.docs) {
      const e = d.data();
      seq += 1;
      if (e.seq !== seq) return { ok: false, problem: `gap or reorder at seq ${seq}`, entries: seq };
      if (e.prevHash !== prev) return { ok: false, problem: `broken chain at seq ${seq}`, entries: seq };
      const { txId, account, side, amountKobo, balanceAfterKobo, type, at } = e;
      balance += side === normal ? amountKobo : -amountKobo;
      if (balance !== balanceAfterKobo) return { ok: false, problem: `balance mismatch at seq ${seq}`, entries: seq };
      const h = entryHash(prev, { txId, account, side, amountKobo, balanceAfterKobo, seq: e.seq, type, at });
      if (h !== e.hash) return { ok: false, problem: `tampered entry at seq ${seq}`, entries: seq };
      prev = h;
    }
    if (page.size < 500) break;
    last = page.docs[page.docs.length - 1];
  }
  if (seq !== acct.get("seq")) return { ok: false, problem: "entry count differs from account", entries: seq };
  if (balance !== acct.get("balanceKobo")) return { ok: false, problem: "cached balance differs from entries", entries: seq };
  if (prev !== acct.get("lastHash")) return { ok: false, problem: "head hash differs", entries: seq };
  return { ok: true, entries: seq };
}

/**
 * Checks one entry without walking its whole account: its hash must recompute from its own
 * fields, the next entry (or the account head) must point back at it, and its transaction
 * header must exist and balance. Enough to vouch for a single receipt.
 */
export async function verifyEntry(e: FirebaseFirestore.DocumentData): Promise<{ ok: boolean; problem?: string }> {
  const { txId, account, side, amountKobo, balanceAfterKobo, seq, type, at } = e;
  if (entryHash(e.prevHash, { txId, account, side, amountKobo, balanceAfterKobo, seq, type, at }) !== e.hash) return { ok: false, problem: "entry hash does not recompute" };
  const [next, acct, head] = await Promise.all([
    db.doc(`ledgerEntries/${account}__${String(seq + 1).padStart(10, "0")}`).get(),
    db.doc(`wallets/${account}`).get(),
    db.doc(`ledgerTx/${txId}`).get(),
  ]);
  const linked = next.exists ? next.get("prevHash") === e.hash : acct.get("lastHash") === e.hash;
  if (!linked) return { ok: false, problem: "entry is not in the account's chain" };
  if (!head.exists) return { ok: false, problem: "missing transaction header" };
  const legs = head.get("legs") as Leg[];
  const sum = (s: Side) => legs.filter((l) => l.side === s).reduce((t, l) => t + l.amountKobo, 0);
  if (sum("debit") !== sum("credit")) return { ok: false, problem: "transaction does not balance" };
  if (!legs.some((l) => l.account === account && l.side === side && l.amountKobo === amountKobo)) return { ok: false, problem: "entry is not a leg of its transaction" };
  return { ok: true };
}
