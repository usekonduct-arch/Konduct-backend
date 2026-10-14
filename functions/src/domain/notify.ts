/**
 * Push notifications (FR-NTF-01). Best effort: a failed push never fails a payment, because
 * the money record and the realtime driverFeed are the source of truth. Messages carry no
 * personal data beyond what the recipient already owns (SEC-DATA-04).
 */
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";

import { db, FieldValue, stamp } from "../lib/db";

export type Push = { title: string; body: string; data?: Record<string, string>; channel?: string; critical?: boolean };

export async function notify(uid: string, kind: string, push: Push) {
  try {
    await db.collection(`users/${uid}/notifications`).add({ kind, title: push.title, body: push.body, data: push.data ?? {}, read: false, ...stamp() });
    const devices = await db.collection(`users/${uid}/devices`).where("active", "==", true).limit(5).get();
    const tokens = devices.docs.map((d) => d.get("fcmToken") as string).filter(Boolean);
    if (!tokens.length) return;
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: push.title, body: push.body },
      data: { kind, ...(push.data ?? {}) },
      android: { priority: "high", notification: { channelId: push.channel ?? "konduct_default", sound: push.critical ? "payment" : "default" } },
    });
    // Forget tokens the device no longer accepts.
    res.responses.forEach((r, i) => {
      const code = r.error?.code ?? "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        void devices.docs[i]?.ref.update({ active: false, deactivatedAt: FieldValue.serverTimestamp() });
      }
    });
  } catch (e) {
    logger.warn("push failed", { kind, err: (e as Error).message });
  }
}
