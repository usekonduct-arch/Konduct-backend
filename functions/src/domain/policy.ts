import type { Transaction } from "firebase-admin/firestore";

import { KYC_LIMITS } from "../config";
import { db, lagosDay } from "../lib/db";
import { fail } from "../lib/errors";

/** Kill switches (SEC-OPS-05): pause money flows without a redeploy. Only admins write this. */
export type Switches = {
  paymentsPaused: boolean;
  fundingPaused: boolean;
  payoutsPaused: boolean;
  /** Set by reconciliation when the books don't match Bachs (SEC-PAY-07). */
  payoutsHaltedByRecon: boolean;
  disabledRoutes: string[];
};

const DEFAULTS: Switches = { paymentsPaused: false, fundingPaused: false, payoutsPaused: false, payoutsHaltedByRecon: false, disabledRoutes: [] };
export const switchesRef = () => db.doc("config/switches");

export async function getSwitches(tx?: Transaction): Promise<Switches> {
  const snap = tx ? await tx.get(switchesRef()) : await switchesRef().get();
  return { ...DEFAULTS, ...(snap.data() ?? {}) } as Switches;
}

export function assertOpen(s: Switches, flow: "payments" | "funding" | "payouts") {
  if (flow === "payments" && s.paymentsPaused) fail("unavailable", "payments_paused", "Payments are paused for a moment. Please pay the driver in cash.");
  if (flow === "funding" && s.fundingPaused) fail("unavailable", "funding_paused", "Adding money is paused for a moment. Try again shortly.");
  if (flow === "payouts" && (s.payoutsPaused || s.payoutsHaltedByRecon)) fail("unavailable", "payouts_paused", "Payouts are paused while we check the books. Your money is safe.");
}

export const limitsFor = (tier: unknown) => KYC_LIMITS[Number(tier)] ?? KYC_LIMITS[1];

/** Per-person running totals for today (Lagos day). Group payments count in full (FR-GRP-06). */
export const dailyRef = (uid: string, day = lagosDay()) => db.doc(`dailyTotals/${uid}__${day}`);

export type Daily = { spendKobo: number; fundKobo: number; pays: number };
export const readDaily = (snap: FirebaseFirestore.DocumentSnapshot): Daily => ({
  spendKobo: snap.get("spendKobo") ?? 0,
  fundKobo: snap.get("fundKobo") ?? 0,
  pays: snap.get("pays") ?? 0,
});
