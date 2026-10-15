/**
 * Push notifications (FR-NTF-01). Best effort: a failed push never fails a payment, because
 * the money record and the realtime driverFeed are the source of truth. Messages carry no
 * personal data beyond what the recipient already owns (SEC-DATA-04).
 */
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";

import { db, FieldValue, stamp } from "../lib/db";
import { translate } from "./i18n";

/**
 * Money alerts are spoken. Each kind has its own Android channel whose sound is a recorded voice
 * clip in the apps (res/raw/<sound>.wav), played on the alarm stream so it is heard on silent;
 * with the app open, the app speaks the amount instead (lib/messages/voice.dart).
 */
const VOICE: Record<string, { channel: string; sound: string }> = {
  "fare.received": { channel: "konduct_voice_fare", sound: "voice_fare_received" },
  "wallet.funded": { channel: "konduct_voice_wallet", sound: "voice_wallet_funded" },
  "payout.paid": { channel: "konduct_voice_payout", sound: "voice_payout_sent" },
};

export type Push = {
  title: string;
  body: string;
  data?: Record<string, string>;
  channel?: string;
  critical?: boolean;
  /** Shown in the inbox and, for a push, in the expanded notification. */
  imageUrl?: string | null;
  /** https:// page or app:<screen> shortcut the message's button opens. */
  link?: string | null;
  linkLabel?: string | null;
  /** Opens over the app the next time it's in front. */
  popup?: boolean;
};

export async function notify(uid: string, kind: string, push: Push, opts: { push?: boolean } = {}) {
  try {
    await db.collection(`users/${uid}/notifications`).add({
      kind,
      title: push.title,
      body: push.body,
      data: push.data ?? {},
      imageUrl: push.imageUrl ?? null,
      link: push.link ?? null,
      linkLabel: push.linkLabel ?? null,
      popup: push.popup ?? false,
      read: false,
      createdAtMs: Date.now(),
      ...stamp(),
    });
    if (opts.push === false) return;
    const [devices, user] = await Promise.all([db.collection(`users/${uid}/devices`).where("active", "==", true).limit(5).get(), db.doc(`users/${uid}`).get()]);
    const tokens = devices.docs.map((d) => d.get("fcmToken") as string).filter(Boolean);
    if (!tokens.length) return;
    // The inbox keeps English (the app translates it on screen); the push is in the person's language.
    const lang = user.get("lang");
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: translate(lang, push.title), body: translate(lang, push.body), ...(push.imageUrl ? { imageUrl: push.imageUrl } : {}) },
      data: { kind, popup: push.popup ? "1" : "0", ...(push.link ? { link: push.link } : {}), ...(push.data ?? {}) },
      android: {
        priority: "high",
        notification: {
          channelId: VOICE[kind]?.channel ?? push.channel ?? "konduct_default",
          sound: VOICE[kind]?.sound ?? "default",
          ...(push.imageUrl ? { imageUrl: push.imageUrl } : {}),
        },
      },
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
