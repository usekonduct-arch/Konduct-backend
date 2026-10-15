/**
 * Background jobs. Firebase runs them with onSchedule (index.ts); on Render an external cron
 * calls POST /jobs/<name> (server.ts). Each one is safe to run twice.
 */
import { logger } from "firebase-functions";

import { db, touched } from "./lib/db";
import { payoutDriver, reconcilePayouts } from "./domain/payouts";
import { reconcileTopUps } from "./domain/funding";
import { reconcile } from "./domain/recon";
import { rebuildBoard } from "./domain/board";

/** FR-DRV-03: daily automatic payout is the default, after the evening rush. */
async function dailyPayoutRun() {
  const drivers = await db.collection("users").where("role", "==", "driver").where("status", "==", "active").where("payoutAccountId", "!=", null).get();
  const tally: Record<string, number> = {};
  for (const d of drivers.docs) {
    try {
      const r = await payoutDriver(d.id, "daily");
      tally[r.status] = (tally[r.status] ?? 0) + 1;
    } catch (e) {
      tally.error = (tally.error ?? 0) + 1;
      logger.error("payout failed", { uid: d.id, err: (e as Error).message });
    }
  }
  logger.info("payout run", tally);
}

/** FR-DSP-02: raise disputes that are past their SLA. */
async function disputeSlaWatch() {
  const late = await db.collection("disputes").where("state", "in", ["open", "under_review"]).where("slaDueAtMs", "<", Date.now()).limit(200).get();
  for (const d of late.docs) {
    if (!d.get("slaBreached")) await d.ref.update({ slaBreached: true, ...touched() });
  }
}

/** Name → job. Schedules (Africa/Lagos): payouts 21:30, reconcile 02:30, payout check every 15 min, SLA hourly. */
export const JOBS: Record<string, () => Promise<unknown>> = {
  dailyPayoutRun,
  reconcileDaily: reconcile,
  // The 15-minute cron also re-checks open top-ups, so no extra cron entry is needed.
  reconcilePayoutsJob: async () => ({ payouts: await reconcilePayouts(), topups: await reconcileTopUps() }),
  reconcileTopUpsJob: reconcileTopUps,
  disputeSlaWatch,
  /** The riders' bus board, rebuilt from every vehicle (the server also does this when it starts). */
  rebuildBoard,
};
