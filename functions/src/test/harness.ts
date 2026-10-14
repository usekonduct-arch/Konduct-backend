/**
 * Shared set-up for emulator tests (*.emu.ts). Import this FIRST: it sets the secrets and params
 * the code reads, and replaces fetch with a scripted fake Bachs.
 */
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT ?? "demo-konduct",
  IDENTITY_KEY: "test-identity-key",
  QR_SIGNING_KEY: "test-qr-key",
  OFFLINE_CODE_KEY: "test-offline-key",
  BACHS_API_KEY: "sk_sandbox_test",
  BACHS_WEBHOOK_SECRETS: "whsec_test",
  BACHS_ACCOUNT_ID: "acct_konduct",
  TOPUP_RETURN_URL: "https://konduct.example/topup",
  DRIVER_CONTACT_EMAIL: "ops+{uid}@konduct.example",
});
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run emulator tests with `npm run test:emulator`.");

/* ------------------------------------------------------------ fake Bachs */

type Route = (body: any, headers: Record<string, string>) => { status?: number; json: unknown };
export const bachsCalls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
const routes = new Map<string, Route>();
export function onBachs(method: string, pathPrefix: string, r: Route) {
  routes.set(`${method} ${pathPrefix}`, r);
}
export function resetBachs() {
  routes.clear();
  bachsCalls.length = 0;
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(String(input));
  if (!url.host.endsWith("bachs.io")) return realFetch(input, init);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const body = init.body ? JSON.parse(init.body) : undefined;
  const method = init.method ?? "GET";
  bachsCalls.push({ method, path: url.pathname + url.search, body, headers });
  const key = [...routes.keys()].filter((k) => `${method} ${url.pathname}`.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) return new Response(JSON.stringify({ error_code: "NOT_FOUND", detail: "no fake route" }), { status: 404 });
  const r = routes.get(key)!(body, headers);
  return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "x-request-id": "req_test" } });
}) as typeof fetch;

/* --------------------------------------------------------------- fixtures */

import { auth, db, stamp } from "../lib/db";
import type { Actor, Role } from "../lib/guards";
import { driverAccount, openAccountWrite, PLATFORM, prepare, riderAccount } from "../ledger/ledger";
import { makeVehicleToken } from "../domain/qr";

let n = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`.replace(/[^A-Za-z0-9]/g, "").padEnd(12, "0");

export function actorFor(uid: string, role: Role, user: Record<string, unknown>, authTime = Math.floor(Date.now() / 1000)): Actor {
  return { uid, role, email: `${uid}@konduct.test`, authTime, ip: "203.0.113.9", user };
}

export async function makeRider(balanceKobo = 0, extra: Record<string, unknown> = {}) {
  const uid = uniq("rdr");
  const email = `${uid.toLowerCase()}@konduct.test`;
  await auth.createUser({ uid, email, password: "test-password-1" });
  await auth.setCustomUserClaims(uid, { role: "rider", pin: true, status: "active" });
  const user = { role: "rider", status: "active", fullName: "Ada Okafor", kycTier: 1, pinSet: true, ...extra };
  await db.runTransaction(async (tx) => {
    tx.set(db.doc(`users/${uid}`), { ...user, ...stamp() });
    openAccountWrite(tx, riderAccount(uid), "rider", uid);
  });
  if (balanceKobo) await fund(uid, balanceKobo);
  return { uid, email, actor: actorFor(uid, "rider", user) };
}

export async function fund(uid: string, kobo: number) {
  await db.runTransaction(async (tx) => {
    const l = await prepare(tx, {
      txId: uniq("seed_"),
      type: "seed",
      legs: [
        { account: PLATFORM.bachsFloat, side: "debit", amountKobo: kobo },
        { account: riderAccount(uid), side: "credit", amountKobo: kobo },
      ],
    });
    l.commit();
  });
}

export async function makeDriverWithVehicle(fareKobo = 20_000) {
  const uid = uniq("drv");
  await auth.createUser({ uid, email: `${uid.toLowerCase()}@konduct.test`, password: "test-password-1" });
  await auth.setCustomUserClaims(uid, { role: "driver", pin: true, status: "active" });
  const routeId = uniq("route");
  const vehicleId = uniq("veh");
  const user = { role: "driver", status: "active", fullName: "Tunde Adebayo", vehicleId, pinSet: true };
  await db.runTransaction(async (tx) => {
    tx.set(db.doc(`users/${uid}`), { ...user, ...stamp() });
    openAccountWrite(tx, driverAccount(uid), "driver", uid);
    tx.set(db.doc(`routes/${routeId}`), { name: "Main Gate → Faculty", stops: ["Main Gate", "Faculty"], fareKobo, fareVersion: 1, active: true, ...stamp() });
    tx.set(db.doc(`vehicles/${vehicleId}`), { plate: "OS 452 KJA", type: "shuttle", capacity: 14, routeId, driverUid: uid, tokenVersion: 1, tokenIssuedAt: new Date(0), shortCode: uniq("").slice(-6).toUpperCase(), status: "active", ...stamp() });
  });
  const token = makeVehicleToken(process.env.QR_SIGNING_KEY!, vehicleId, 1);
  return { uid, routeId, vehicleId, token, actor: actorFor(uid, "driver", user) };
}

export async function balance(account: string) {
  return ((await db.doc(`wallets/${account}`).get()).get("balanceKobo") as number) ?? 0;
}

export async function setPin(uid: string, pin: string) {
  const { hashPin } = await import("../pin");
  await db.doc(`pins/${uid}`).set({ ...(await hashPin(pin)), length: pin.length, failedAttempts: 0, lockedUntil: 0, ...stamp() });
}

/** Builds a signed Bachs webhook request and a capturing response. */
export function webhook(event: unknown, opts: { secret?: string; ts?: number; tamper?: boolean } = {}) {
  const body = JSON.stringify(event);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", opts.secret ?? "whsec_test").update(`${ts}.${body}`).digest("hex");
  const raw = Buffer.from(opts.tamper ? body.replace("0", "9") : body);
  const headers: Record<string, string> = { "x-bachs-signature-v2": `t=${ts},v1=${sig}` };
  const req = { method: "POST", rawBody: raw, get: (h: string) => headers[h.toLowerCase()] ?? undefined } as any;
  const res: any = { code: 0, text: "" };
  res.status = (c: number) => ((res.code = c), res);
  res.send = (t: string) => ((res.text = t), res);
  return { req, res };
}

export const keyOf = () => uniq("idem").padEnd(20, "x");
