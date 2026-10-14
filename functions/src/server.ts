/**
 * Render entry point: the same endpoints as index.ts, served by one Express process instead of
 * Cloud Functions, so the backend runs on Firebase's free Spark plan (Firestore, Auth and FCM
 * through the Admin SDK; no Cloud Functions, Scheduler or Secret Manager).
 *
 *  POST /<callable name>   Firebase callable protocol: the apps use httpsCallableFromURL(BASE_URL/<name>)
 *                          Authorization: Bearer <ID token>, X-Firebase-AppCheck: <App Check token>
 *  POST /bachsWebhook      Bachs webhooks (raw body, signature-verified)
 *  POST /jobs/<name>       scheduled jobs, called by an external cron with Authorization: Bearer <JOBS_SECRET>
 *  GET  /healthz
 *
 * Secrets and params come from environment variables of the same names. Firestore credentials:
 * FIREBASE_SERVICE_ACCOUNT holding the service-account key JSON, or GOOGLE_APPLICATION_CREDENTIALS naming a key file.
 */
import express, { type NextFunction, type Response } from "express";
import { logger } from "firebase-functions";
import { HttpsError, type CallableRequest, type Request } from "firebase-functions/v2/https";
import { getAppCheck } from "firebase-admin/app-check";

import type { Callable } from "./api/callable";
import { ENFORCE_APP_CHECK } from "./config";
import { handleBachsWebhook } from "./bachs/webhook";
import { safeEqual } from "./lib/crypto";
import { auth } from "./lib/db";
import { JOBS } from "./jobs";
import * as endpoints from "./index";

const REQUIRED_ENV = [
  "IDENTITY_KEY",
  "QR_SIGNING_KEY",
  "OFFLINE_CODE_KEY",
  "BACHS_API_KEY",
  "BACHS_WEBHOOK_SECRETS",
  "BACHS_ACCOUNT_ID",
  "TOPUP_RETURN_URL",
  "DRIVER_CONTACT_EMAIL",
  "JOBS_SECRET",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
// The Firebase key: inline JSON, or a secret file.
if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) missing.unshift("FIREBASE_SERVICE_ACCOUNT");
if (missing.length) {
  logger.error("missing environment variables; refusing to start", { missing });
  process.exit(1);
}

const callables = new Map<string, Callable>(
  Object.entries(endpoints).filter((e): e is [string, Callable & typeof e[1]] => typeof (e[1] as Partial<Callable>)?.run === "function"),
);

const app = express();
app.disable("x-powered-by");

/** Keep the raw bytes: the webhook signature is over them, and callables expose rawRequest.rawBody. */
const keepRaw = (req: express.Request, _res: Response, buf: Buffer) => {
  (req as Request).rawBody = buf;
};

app.get("/healthz", (_req, res) => void res.status(200).send("ok"));

/**
 * The staff console is a website, so browsers need CORS. Only origins in CONSOLE_ORIGINS (comma-separated,
 * for example https://konduct-console.vercel.app) may call from a page; the apps don't send an Origin.
 */
const consoleOrigins = new Set(
  (process.env.CONSOLE_ORIGINS ?? "http://localhost:5190")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
);
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && consoleOrigins.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firebase-AppCheck, Firebase-Instance-ID-Token, X-Firebase-GMPID, X-Client-Version");
    res.set("Access-Control-Max-Age", "3600");
  }
  if (req.method === "OPTIONS") return void res.status(origin && consoleOrigins.has(origin) ? 204 : 403).end();
  next();
});

app.post("/bachsWebhook", express.raw({ type: () => true, limit: "256kb", verify: keepRaw }), (req, res) => handleBachsWebhook(req as Request, res));

const running = new Set<string>();
app.post("/jobs/:name", (req, res) => {
  const name = String(req.params.name);
  const given = (req.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!safeEqual(given, process.env.JOBS_SECRET!)) return void res.status(401).send("unauthorized");
  const job = Object.hasOwn(JOBS, name) ? JOBS[name] : undefined;
  if (!job) return void res.status(404).send("unknown job");
  if (running.has(name)) return void res.status(409).send("already running");
  // Answer now: cron services time out long before a payout run finishes.
  running.add(name);
  res.status(202).send("started");
  const started = Date.now();
  job()
    .then(() => logger.info("job done", { name, ms: Date.now() - started }))
    .catch((e) => logger.error("job failed", { name, err: (e as Error).message }))
    .finally(() => running.delete(name));
});

function sendError(res: Response, e: HttpsError) {
  res.status(e.httpErrorCode.status).json({ error: e.toJSON() });
}

app.post("/:name", express.json({ limit: "64kb", verify: keepRaw }), async (req, res) => {
  const fn = callables.get(String(req.params.name));
  if (!fn) return void res.status(404).json({ error: { status: "NOT_FOUND", message: "Not found" } });
  if (!req.body || typeof req.body !== "object" || !("data" in req.body)) {
    return sendError(res, new HttpsError("invalid-argument", "Bad request."));
  }

  // Same token checks onCall does before running the handler.
  let authData: CallableRequest["auth"];
  const bearer = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) {
    try {
      authData = { uid: "", token: await auth.verifyIdToken(bearer), rawToken: bearer };
      authData.uid = authData.token.uid;
    } catch (e) {
      logger.warn("id token rejected", { code: (e as { code?: string }).code, reason: (e as Error).message });
      return sendError(res, new HttpsError("unauthenticated", "Please sign in again."));
    }
  }

  let appData: CallableRequest["app"];
  const appToken = req.get("x-firebase-appcheck");
  if (appToken) {
    try {
      const v = await getAppCheck().verifyToken(appToken);
      appData = { appId: v.appId, token: v.token };
    } catch {
      if (ENFORCE_APP_CHECK) return sendError(res, new HttpsError("unauthenticated", "Update the app and try again."));
    }
  }
  if (ENFORCE_APP_CHECK && !appData) return sendError(res, new HttpsError("unauthenticated", "Update the app and try again."));

  try {
    const result = await fn.run({ data: req.body.data, auth: authData, app: appData, rawRequest: req as unknown as Request, acceptsStreaming: false });
    res.status(200).json({ result: result ?? null });
  } catch (e) {
    sendError(res, e instanceof HttpsError ? e : new HttpsError("internal", "Something went wrong on our side. Try again."));
  }
});

app.use((err: Error & { status?: number }, _req: express.Request, res: Response, _next: NextFunction) => {
  // Body-parser errors (bad JSON, too large) and anything else that escaped a route.
  if (err.status && err.status < 500) return void res.status(err.status).json({ error: { status: "INVALID_ARGUMENT", message: "Bad request." } });
  logger.error("unhandled server error", { err: err.message });
  res.status(500).json({ error: { status: "INTERNAL", message: "Internal error." } });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => logger.info("konduct backend listening", { port, callables: callables.size, appCheck: ENFORCE_APP_CHECK }));
