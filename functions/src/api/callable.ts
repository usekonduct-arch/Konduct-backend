import { logger } from "firebase-functions";
import { type CallableRequest, HttpsError, onCall } from "firebase-functions/v2/https";
import type { SecretParam } from "firebase-functions/params";
import { z } from "zod";

import { ENFORCE_APP_CHECK, REGION } from "../config";

/** Anything `callable()` returns: the server can run it outside Cloud Functions. */
export type Callable = { run: (req: CallableRequest) => Promise<unknown> };

type Opts = { secrets?: SecretParam[]; minInstances?: number; memory?: "256MiB" | "512MiB" | "1GiB"; timeoutSeconds?: number };

/**
 * Every app-facing endpoint goes through here (SEC-APP-02/03):
 * - App Check token required when enforced (ENFORCE_APP_CHECK); rejected before the handler runs
 * - input parsed with a strict schema (unknown fields rejected)
 * - unexpected errors become a generic "internal" so stack traces and internals never leak
 *
 * Replay of a money call is defeated by the endpoints themselves, not by App Check: confirmPayment
 * and createTopUp are idempotent on their key, and payouts hold a PIN plus a one-in-progress lock.
 * App Check *consume*-based replay protection is deliberately not used — it needs the apps to send
 * limited-use tokens (getLimitedUseToken), and consuming the SDK's normal cached token would reject
 * every genuine call until it refreshed. See docs/security.md if that trade changes.
 */
export function callable<S extends z.ZodType, R>(schema: S, handler: (req: CallableRequest, data: z.infer<S>) => Promise<R>, opts: Opts = {}) {
  const run = async (req: CallableRequest): Promise<R> => {
    const parsed = schema.safeParse(req.data ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpsError("invalid-argument", issue?.message?.length && issue.message.length < 120 ? issue.message : "Check your details and try again.", { reason: "invalid_input" });
    }
    try {
      return await handler(req, parsed.data);
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error("unhandled error", { fn: req.rawRequest?.path, err: (e as Error).message, stack: (e as Error).stack?.split("\n").slice(0, 4).join(" | ") });
      throw new HttpsError("internal", "Something went wrong on our side. Nothing was charged twice; try again.", { reason: "internal" });
    }
  };
  // `run` is the same checks without the Cloud Functions wrapper, for the Render server (server.ts).
  const fn = onCall(
    {
      region: REGION,
      enforceAppCheck: ENFORCE_APP_CHECK,
      cors: false, // mobile apps only; the admin console gets its own origin list when built
      secrets: opts.secrets ?? [],
      minInstances: opts.minInstances ?? 0,
      memory: opts.memory ?? "256MiB",
      timeoutSeconds: opts.timeoutSeconds ?? 30,
      maxInstances: 50,
    },
    run,
  );
  return Object.assign(fn, { run });
}

export const Empty = z.strictObject({});

const LONG_TYPES = new Set(["type.googleapis.com/google.protobuf.Int64Value", "type.googleapis.com/google.protobuf.UInt64Value"]);

/**
 * The Firebase callable wire format sends 64-bit integers wrapped, as
 * {"@type": "type.googleapis.com/google.protobuf.Int64Value", "value": "200000"}. The Android SDK
 * does this for every Dart int. Cloud Functions' onCall unwraps them before the handler runs; the
 * Render server (server.ts) calls `run` directly, so it unwraps them here, the same way.
 * Anything else carrying an "@type" is refused.
 */
export function decodeCallableData(data: unknown): unknown {
  if (data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(decodeCallableData);
  const obj = data as Record<string, unknown>;
  if ("@type" in obj) {
    const value = typeof obj.value === "string" ? Number(obj.value) : NaN;
    if (!LONG_TYPES.has(String(obj["@type"])) || !Number.isFinite(value)) throw new Error("undecodable callable value");
    return value;
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, decodeCallableData(v)]));
}
