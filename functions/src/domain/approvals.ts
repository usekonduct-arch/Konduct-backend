/**
 * Maker-checker (FR-ADM-03, SEC-PAY-06). Sensitive actions are requested by one person and
 * executed when a staff member with the right role approves them. That must be a *different*
 * person, except that an admin may approve their own request (the owner's choice for a small
 * team); such decisions are marked selfApproved. Each request and decision is audited with who,
 * when and from where (FR-ADM-05).
 */
import { z } from "zod";

import { CAMPUS_ID } from "../config";
import { audit } from "../lib/audit";
import { auth, db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, STAFF_ROLES, type StaffRole } from "../lib/guards";
import { PLATFORM, prepare, riderAccount, type Side } from "../ledger/ledger";
import { mergeClaims } from "./accounts";
import { switchesRef } from "./policy";

export type ApprovalKind = "payout_account" | "refund" | "ledger_adjustment" | "deposit_assign" | "kyc_tier" | "role_grant" | "recon_release";

/** Who may approve each kind. */
const CHECKERS: Record<ApprovalKind, StaffRole[]> = {
  payout_account: ["admin", "ops"],
  refund: ["admin", "ops"],
  deposit_assign: ["admin", "ops"],
  ledger_adjustment: ["admin"],
  kyc_tier: ["admin"],
  role_grant: ["admin"],
  recon_release: ["admin"],
};

export async function requestApproval(r: { kind: ApprovalKind; makerUid: string; target: string; summary: string; payload: Record<string, unknown> }) {
  const ref = db.collection("approvals").doc();
  await db.runTransaction(async (tx) => {
    tx.create(ref, { ...r, status: "pending", checkerUid: null, decidedAtMs: null, ...stamp() });
    audit({ actor: r.makerUid, action: `approval.request.${r.kind}`, target: ref.path, after: { summary: r.summary } }, tx);
  });
  return { approvalId: ref.id, status: "pending" };
}

export async function decide(actor: Actor, approvalId: string, decision: "approve" | "reject", note?: string) {
  const ref = db.doc(`approvals/${approvalId}`);
  const a = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("not-found", "no_approval", "No such request.");
    const kind = snap.get("kind") as ApprovalKind;
    if (snap.get("status") !== "pending") fail("failed-precondition", "decided", "This request was already decided.");
    const own = snap.get("makerUid") === actor.uid;
    if (own && actor.role !== "admin") fail("permission-denied", "same_person", "Someone else has to approve your own request.");
    if (!CHECKERS[kind].includes(actor.role as StaffRole)) fail("permission-denied", "wrong_role", "Your role can't approve this.");
    tx.update(ref, { status: decision === "approve" ? "executing" : "rejected", checkerUid: actor.uid, selfApproved: own, note: note ?? null, decidedAtMs: Date.now(), ...touched() });
    audit({ actor: actor.uid, action: `approval.${decision}.${kind}`, target: ref.path, ip: actor.ip, after: own ? { selfApproved: true } : undefined }, tx);
    return snap.data()!;
  });
  if (decision === "reject") return { status: "rejected" };
  try {
    const result = await execute(a.kind as ApprovalKind, a.payload, actor.uid, approvalId);
    await ref.update({ status: "approved", result: result ?? null, ...touched() });
    return { status: "approved", result };
  } catch (e) {
    await ref.update({ status: "failed", error: (e as Error).message.slice(0, 200), ...touched() });
    throw e;
  }
}

const Adjustment = z.strictObject({ account: z.string().regex(/^[A-Za-z0-9_-]{3,80}$/), side: z.enum(["debit", "credit"]), amountKobo: z.number().int().positive(), memo: z.string().min(5).max(200) });

async function execute(kind: ApprovalKind, payload: Record<string, unknown>, checkerUid: string, approvalId: string) {
  switch (kind) {
    case "payout_account": {
      const { activatePayoutAccount } = await import("./payouts");
      return activatePayoutAccount(String(payload.payoutAccountId), checkerUid);
    }
    case "refund": {
      const { executeRefund } = await import("./disputes");
      return executeRefund(String(payload.disputeId), Number(payload.amountKobo), checkerUid);
    }
    case "ledger_adjustment": {
      const p = Adjustment.parse(payload);
      const other: Side = p.side === "debit" ? "credit" : "debit";
      await db.runTransaction(async (tx) => {
        const ledger = await prepare(tx, {
          txId: `adjust_${approvalId}`,
          type: "adjustment",
          legs: [
            { account: p.account, side: p.side, amountKobo: p.amountKobo },
            { account: PLATFORM.adjustments, side: other, amountKobo: p.amountKobo },
          ],
          memo: p.memo,
          refs: { approvalId },
        });
        ledger.commit();
      });
      return { posted: `adjust_${approvalId}` };
    }
    case "deposit_assign": {
      const depositId = String(payload.depositId);
      const uid = String(payload.uid);
      await db.runTransaction(async (tx) => {
        const [dep, user] = await tx.getAll(db.doc(`deposits/${depositId}`), db.doc(`users/${uid}`));
        if (dep.get("status") !== "unmatched") fail("failed-precondition", "not_unmatched", "This deposit is already assigned.");
        if (user.get("role") !== "rider") fail("failed-precondition", "not_rider", "Deposits can only go to a rider wallet.");
        const amountKobo = dep.get("amountKobo") as number;
        const ledger = await prepare(tx, {
          txId: `assign_${depositId}`,
          type: "deposit.assign",
          legs: [
            { account: PLATFORM.suspense, side: "debit", amountKobo },
            { account: riderAccount(uid), side: "credit", amountKobo },
          ],
          refs: { depositId, approvalId },
        });
        ledger.commit();
        tx.update(dep.ref, { status: "credited", uid, matchedBy: "staff", ...touched() });
      });
      return { assigned: uid };
    }
    case "kyc_tier": {
      const tier = Number(payload.tier);
      if (![1, 2].includes(tier)) fail("invalid-argument", "bad_tier", "Unknown tier.");
      await db.doc(`users/${payload.uid}`).update({ kycTier: tier, ...touched() });
      return { tier };
    }
    case "role_grant": {
      const role = String(payload.role);
      const uid = String(payload.uid);
      if (!(STAFF_ROLES as readonly string[]).includes(role) && role !== "none") fail("invalid-argument", "bad_role", "Unknown role.");
      const user = await auth.getUser(uid);
      if (!user.email || !user.emailVerified) fail("failed-precondition", "email_unverified", "Staff need a verified email first.");
      if (role === "none") {
        await db.doc(`users/${uid}`).set({ role: "none", status: "suspended", ...touched() }, { merge: true });
        await mergeClaims(uid, { role: null, staff: false });
      } else {
        await db.doc(`users/${uid}`).set({ role, status: "active", email: user.email, ...stamp() }, { merge: true });
        await mergeClaims(uid, { role, staff: true, campus: CAMPUS_ID });
      }
      await auth.revokeRefreshTokens(uid); // the new role applies from the next sign-in
      return { role };
    }
    case "recon_release": {
      await switchesRef().set({ payoutsHaltedByRecon: false, ...touched() }, { merge: true });
      return { released: true };
    }
  }
}
