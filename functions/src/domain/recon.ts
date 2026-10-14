/**
 * Nightly reconciliation (FR-ADM-04, SEC-PAY-07) and ledger integrity (SRS 5).
 *
 * 1. Every wallet touched since the last run is re-derived from its hash-chained entries.
 * 2. The ledger's Bachs float, minus money already transferred into driver payouts that haven't
 *    settled, must equal the NGN balance Bachs reports.
 * Any problem, or a variance above tolerance, halts automatic payouts until an admin request is
 * approved by a second admin (recon_release), and leaves an alert for the on-call person.
 */
import { logger } from "firebase-functions";

import { RULES } from "../config";
import { getBalances } from "../bachs/client";
import { db, lagosDay, stamp, Timestamp, touched } from "../lib/db";
import { toKobo } from "../lib/money";
import { PLATFORM, verifyAccount } from "../ledger/ledger";
import { switchesRef } from "./policy";

function readNgn(b: Record<string, unknown>): number | null {
  const list = (b.balances ?? b.data ?? []) as { currency?: string; available_balance?: string; pending_balance?: string }[];
  const ngn = Array.isArray(list) ? list.find((x) => x.currency === "NGN") : undefined;
  if (!ngn?.available_balance) return null;
  return toKobo(ngn.available_balance) + (ngn.pending_balance ? toKobo(ngn.pending_balance) : 0);
}

export async function reconcile() {
  const started = Date.now();
  const since = Timestamp.fromMillis(started - 26 * 3_600_000);
  const problems: string[] = [];

  // 1. Ledger integrity.
  const touchedWallets = await db.collection("wallets").where("updatedAt", ">", since).select().get();
  for (const w of touchedWallets.docs) {
    const r = await verifyAccount(w.id);
    if (!r.ok) problems.push(`ledger ${w.id}: ${r.problem}`);
  }

  // 2. Books vs Bachs.
  const [floatDoc, inFlight] = await Promise.all([
    db.doc(`wallets/${PLATFORM.bachsFloat}`).get(),
    db.collection("payouts").where("status", "in", ["transferred", "submitted", "unknown"]).get(),
  ]);
  const ledgerFloat = (floatDoc.get("balanceKobo") as number) ?? 0;
  const transferredOut = inFlight.docs.filter((d) => d.get("transferId")).reduce((s, d) => s + d.get("amountKobo") + d.get("feeKobo"), 0);
  const expected = ledgerFloat - transferredOut;
  let actual: number | null = null;
  try {
    actual = readNgn(await getBalances());
  } catch (e) {
    problems.push(`bachs balance unavailable: ${(e as Error).message}`);
  }
  if (actual === null && !problems.some((p) => p.startsWith("bachs"))) problems.push("bachs NGN balance missing from response");
  const variance = actual === null ? null : actual - expected;
  if (variance !== null && Math.abs(variance) > RULES.reconToleranceKobo) problems.push(`float variance ${variance} kobo`);

  const [unmatched, openFlags] = await Promise.all([
    db.collection("deposits").where("status", "==", "unmatched").count().get(),
    db.collection("flags").where("status", "==", "open").count().get(),
  ]);

  const day = lagosDay(started);
  const report = {
    day,
    walletsChecked: touchedWallets.size,
    ledgerFloatKobo: ledgerFloat,
    transferredOutKobo: transferredOut,
    expectedBachsKobo: expected,
    actualBachsKobo: actual,
    varianceKobo: variance,
    unmatchedDeposits: unmatched.data().count,
    openFlags: openFlags.data().count,
    problems,
    ok: problems.length === 0,
    tookMs: Date.now() - started,
    ...stamp(),
  };
  await db.doc(`reconReports/${day}`).set(report);
  if (problems.length) {
    await switchesRef().set({ payoutsHaltedByRecon: true, ...touched() }, { merge: true });
    await db.collection("alerts").add({ type: "reconciliation", day, problems: problems.slice(0, 20), status: "open", ...stamp() });
    logger.error("reconciliation failed; payouts halted", { day, count: problems.length });
  }
  return report;
}
