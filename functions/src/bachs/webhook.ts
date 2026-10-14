/**
 * POST /bachsWebhook  (SEC-PAY-03)
 *
 *  - signature: HMAC over "{timestamp}.{raw body}", 5-minute window (replays are refused)
 *  - origin:    must be our Bachs account or one of our drivers' connected accounts
 *  - dedupe:    webhookEvents/{event id}; a processed event is acknowledged and skipped
 *  - truth:     money is credited only after the domain code re-reads Bachs's API
 *  - responses: 400 for forged/unknown deliveries (Bachs stops retrying), 5xx when *we* failed
 *               (Bachs retries up to 5 times), 200 once stored and processed
 */
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { logger } from "firebase-functions";

import { BACHS_ACCOUNT_ID, BACHS_WEBHOOK_SECRETS } from "../config";
import { sha256 } from "../lib/crypto";
import { db, FieldValue, millis, stamp, touched } from "../lib/db";
import { expireTopUp, settleDeposit, settleTopUp } from "../domain/funding";
import { onPayoutEvent } from "../domain/payouts";
import { verifyBachsSignature } from "./signature";

type Event = { id: string; type: string; created_at?: string; organization_id?: string; account?: string; data: Record<string, any> };

export async function handleBachsWebhook(req: Request, res: Response) {
  if (req.method !== "POST") return void res.status(405).send("method not allowed");
  const raw = req.rawBody;
  if (!raw?.length || raw.length > 256 * 1024) return void res.status(413).send("bad body");

  const sig = verifyBachsSignature(
    raw,
    { v2: req.get("X-Bachs-Signature-V2"), timestamp: req.get("X-Bachs-Timestamp"), signature: req.get("X-Bachs-Signature") },
    BACHS_WEBHOOK_SECRETS.value().split(","),
  );
  if (!sig.ok) {
    logger.warn("bachs webhook refused", { why: sig.why });
    return void res.status(400).send("invalid signature");
  }

  let event: Event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return void res.status(400).send("bad json");
  }
  if (typeof event?.id !== "string" || !/^evt_[A-Za-z0-9]{6,64}$/.test(event.id) || typeof event.type !== "string" || typeof event.data !== "object") {
    return void res.status(400).send("bad event");
  }

  // Only our own account and the driver accounts we created may talk to us.
  const ours = BACHS_ACCOUNT_ID.value();
  if (!ours) {
    logger.error("BACHS_ACCOUNT_ID is not configured; refusing webhooks until it is");
    return void res.status(503).send("not configured");
  }
  const origin = event.account ?? event.organization_id ?? "";
  const fromConnected = Boolean(event.account) || origin !== ours;
  if (fromConnected) {
    const known = /^[A-Za-z0-9_]{3,64}$/.test(origin) && (await db.doc(`connectAccounts/${origin}`).get()).exists;
    if (!known) {
      logger.warn("bachs webhook from unknown account", { type: event.type });
      return void res.status(400).send("unknown account");
    }
  }

  const ref = db.doc(`webhookEvents/${event.id}`);
  const go = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists && s.get("status") === "processed") return "done";
    if (s.exists && s.get("status") === "processing" && Date.now() - millis(s.get("updatedAt")) < 60_000) return "busy";
    tx.set(
      ref,
      {
        provider: "bachs",
        type: event.type,
        origin,
        rawHash: sha256(raw.toString("utf8")),
        signedAt: sig.timestamp,
        eventCreatedAt: event.created_at ?? null,
        status: "processing",
        attempts: FieldValue.increment(1),
        ...(s.exists ? touched() : stamp()),
      },
      { merge: true },
    );
    return "go";
  });
  if (go === "done") return void res.status(200).send("duplicate");
  if (go === "busy") return void res.status(503).send("in progress");

  try {
    const outcome = await route(event, fromConnected);
    await ref.update({ status: "processed", outcome, processedAt: FieldValue.serverTimestamp(), ...touched() });
    res.status(200).send("ok");
  } catch (e) {
    logger.error("bachs webhook processing failed", { type: event.type, id: event.id, err: (e as Error).message });
    await ref.update({ status: "failed", error: (e as Error).message.slice(0, 200), ...touched() });
    res.status(500).send("retry");
  }
}

async function route(e: Event, fromConnected: boolean): Promise<string> {
  const d = e.data;
  switch (e.type) {
    case "collection.succeeded": {
      if (fromConnected) return "ignored: driver accounts don't collect";
      if (d.checkout_id) return (await settleTopUp(String(d.checkout_id), d.reference ?? null)).why;
      return (await settleDeposit(e.id, d as Parameters<typeof settleDeposit>[1])).why;
    }
    case "checkout.completed":
      if (fromConnected || d.payment_status !== "paid") return "ignored";
      return (await settleTopUp(String(d.checkout_id), d.reference ?? null)).why;
    case "checkout.expired":
      await expireTopUp(d.reference ?? null);
      return "expired";
    case "payout.paid":
    case "payout.failed":
      return (await onPayoutEvent(e.type, d.reference ?? null, d)).handled ? "payout updated" : "unknown payout";
    case "account.updated":
    case "capability.updated":
      if (fromConnected) await db.doc(`connectAccounts/${e.account ?? e.organization_id}`).set({ lastEvent: e.type, capability: d.capability ?? null, capabilityStatus: d.status ?? null, ...touched() }, { merge: true });
      return "recorded";
    case "dispute.created":
    case "dispute.updated":
      // A card chargeback against a top-up. Freeze nothing automatically; a human decides.
      await db.collection("flags").add({ type: "chargeback", event: e.type, chargeId: d.charge_id ?? null, status: "open", ...stamp() });
      return "flagged";
    default:
      return "ignored";
  }
}
