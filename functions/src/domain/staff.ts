/**
 * Staff operations (FR-ADM-01/02, FR-AUTH-03/09, FR-DRV-08, FR-PAY-09, SEC-OPS-05). Every call is
 * already MFA-checked and role-checked by the API layer; every change is audited with before/after.
 */
import { z } from "zod";

import { QR_SIGNING_KEY } from "../config";
import { audit } from "../lib/audit";
import { randomCode } from "../lib/crypto";
import { auth, db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import type { Actor } from "../lib/guards";
import { cleanName } from "../identity";
import { mergeClaims } from "./accounts";
import { requestApproval } from "./approvals";
import { makeVehicleToken } from "./qr";
import { switchesRef } from "./policy";

const e164 = z
  .string()
  .transform((raw) => {
    let d = raw.replace(/\D/g, "");
    if (d.startsWith("234")) d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
    return `+234${d}`;
  })
  .pipe(z.string().regex(/^\+234[789][01]\d{8}$/, "Enter a Nigerian mobile number."));

/* ------------------------------------------------------------- drivers */

export const InviteDriver = z.strictObject({
  phone: e164,
  fullName: z.string().max(80).transform(cleanName).pipe(z.string().regex(/^[\p{L}'.-]+(\s[\p{L}'.-]+)+$/u)),
  plate: z.string().max(16).transform((s) => s.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z0-9 -]{5,16}$/)),
  type: z.enum(["shuttle", "bike"]),
  routeId: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/),
  capacity: z.number().int().min(1).max(30),
  checks: z.strictObject({ idSeen: z.literal(true), vehiclePapersSeen: z.literal(true), unionConfirmed: z.literal(true) }),
});

/** FR-AUTH-03: an agent onboards a driver at the park after checking ID, papers and union. */
export async function inviteDriver(actor: Actor, input: z.infer<typeof InviteDriver>) {
  const inviteRef = db.doc(`driverInvites/${input.phone}`);
  const vehicleRef = db.collection("vehicles").doc();
  await db.runTransaction(async (tx) => {
    const [existing, route] = await tx.getAll(inviteRef, db.doc(`routes/${input.routeId}`));
    if (existing.exists && existing.get("status") !== "revoked") fail("already-exists", "invite_exists", "This number already has a driver record.");
    if (!route.exists) fail("not-found", "no_route", "Unknown route.");
    tx.set(vehicleRef, {
      plate: input.plate,
      type: input.type,
      capacity: input.capacity,
      routeId: input.routeId,
      driverUid: null,
      ownerRef: null,
      tokenVersion: 0, // no sticker yet; issueVehicleQr prints the first one
      tokenIssuedAt: null,
      shortCode: randomCode(6),
      status: "active",
      ...stamp(),
    });
    tx.set(inviteRef, {
      phone: input.phone,
      fullName: input.fullName,
      vehicleId: vehicleRef.id,
      plate: input.plate,
      vehicleType: input.type === "bike" ? "Bike" : "Shuttle",
      routeName: route.get("name"),
      checks: input.checks,
      onboardedBy: actor.uid,
      status: "pending",
      ...stamp(),
    });
    audit({ actor: actor.uid, action: "driver.invite", target: inviteRef.path, after: { plate: input.plate, vehicleId: vehicleRef.id }, ip: actor.ip }, tx);
  });
  return { vehicleId: vehicleRef.id };
}

/** FR-DRV-08 / SEC-QR-04: issue (or re-issue) a sticker. The old one dies immediately. */
export async function issueVehicleQr(actor: Actor, vehicleId: string) {
  const ref = db.doc(`vehicles/${vehicleId}`);
  const out = await db.runTransaction(async (tx) => {
    const v = await tx.get(ref);
    if (!v.exists) fail("not-found", "no_vehicle", "Unknown vehicle.");
    const version = (v.get("tokenVersion") as number) + 1;
    const shortCode = randomCode(6);
    tx.update(ref, { tokenVersion: version, tokenIssuedAt: new Date(), shortCode, ...touched() });
    audit({ actor: actor.uid, action: "vehicle.qr.issue", target: ref.path, before: { tokenVersion: version - 1 }, after: { tokenVersion: version }, ip: actor.ip }, tx);
    return { version, shortCode, plate: v.get("plate") as string };
  });
  return { token: makeVehicleToken(QR_SIGNING_KEY.value(), vehicleId, out.version), shortCode: out.shortCode, plate: out.plate };
}

export async function setVehicleStatus(actor: Actor, vehicleId: string, status: "active" | "suspended" | "retired") {
  const ref = db.doc(`vehicles/${vehicleId}`);
  await db.runTransaction(async (tx) => {
    const v = await tx.get(ref);
    if (!v.exists) fail("not-found", "no_vehicle", "Unknown vehicle.");
    tx.update(ref, { status, ...touched() });
    audit({ actor: actor.uid, action: "vehicle.status", target: ref.path, before: { status: v.get("status") }, after: { status }, ip: actor.ip }, tx);
  });
  return { status };
}

/* --------------------------------------------------------------- routes */

export const UpsertRoute = z.strictObject({
  routeId: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/),
  name: z.string().min(3).max(60),
  stops: z.array(z.string().min(2).max(60)).min(2).max(30),
  fareKobo: z.number().int().min(5_000).max(500_000).refine((n) => n % 100 === 0, "Whole naira only."),
  active: z.boolean(),
});

/** FR-PAY-09: fares are versioned and audited; a quote priced on an old version is refused. */
export async function upsertRoute(actor: Actor, input: z.infer<typeof UpsertRoute>) {
  const ref = db.doc(`routes/${input.routeId}`);
  return db.runTransaction(async (tx) => {
    const r = await tx.get(ref);
    const fareChanged = !r.exists || r.get("fareKobo") !== input.fareKobo;
    const fareVersion = (r.get("fareVersion") ?? 0) + (fareChanged ? 1 : 0);
    tx.set(ref, { name: input.name, stops: input.stops, fareKobo: input.fareKobo, fareVersion, active: input.active, ...(r.exists ? touched() : stamp()) }, { merge: true });
    if (fareChanged) tx.create(db.doc(`routes/${input.routeId}/fares/v${fareVersion}`), { fareKobo: input.fareKobo, effectiveFromMs: Date.now(), setBy: actor.uid, ...stamp() });
    audit({ actor: actor.uid, action: "route.upsert", target: ref.path, before: r.exists ? { fareKobo: r.get("fareKobo"), active: r.get("active") } : null, after: { fareKobo: input.fareKobo, active: input.active, fareVersion }, ip: actor.ip }, tx);
    return { fareVersion };
  });
}

/* --------------------------------------------------------------- people */

/** FR-ADM-02 + FR-AUTH-09: suspension is instant; refresh tokens are revoked as well. */
export async function setUserStatus(actor: Actor, uid: string, status: "active" | "suspended", reason: string) {
  const ref = db.doc(`users/${uid}`);
  const self = actor.uid === uid;
  if (self && status !== "suspended") fail("permission-denied", "self_unlock", "An agent or support has to unlock your account.");
  await db.runTransaction(async (tx) => {
    const u = await tx.get(ref);
    if (!u.exists) fail("not-found", "no_user", "Unknown person.");
    if (!self && u.get("role") === "admin" && actor.role !== "admin") fail("permission-denied", "wrong_role", "Only an admin can change another admin.");
    tx.update(ref, { status, statusReason: reason, ...touched() });
    audit({ actor: actor.uid, action: `user.${status}`, target: ref.path, before: { status: u.get("status") }, after: { status, reason }, ip: actor.ip }, tx);
  });
  await mergeClaims(uid, { status });
  if (status === "suspended") await auth.revokeRefreshTokens(uid);
  return { status };
}

/** SAF-03: a rider or driver can lock their own wallet instantly; an agent unlocks it. */
export async function lockMyAccount(actor: Actor) {
  await setUserStatus(actor, actor.uid, "suspended", "self-lock");
  return { status: "suspended" };
}

/* ------------------------------------------------------------ switches */

export const SetSwitches = z.strictObject({
  paymentsPaused: z.boolean().optional(),
  fundingPaused: z.boolean().optional(),
  payoutsPaused: z.boolean().optional(),
  disabledRoutes: z.array(z.string().regex(/^[A-Za-z0-9_-]{3,40}$/)).max(50).optional(),
  reason: z.string().min(5).max(200),
});

/** SEC-OPS-05 kill switches. Clearing a reconciliation halt is not here: it needs approval. */
export async function setSwitches(actor: Actor, input: z.infer<typeof SetSwitches>) {
  const { reason, ...patch } = input;
  await db.runTransaction(async (tx) => {
    const before = (await tx.get(switchesRef())).data() ?? {};
    tx.set(switchesRef(), { ...patch, ...touched() }, { merge: true });
    audit({ actor: actor.uid, action: "switches.set", target: "config/switches", before, after: { ...patch, reason }, ip: actor.ip }, tx);
  });
  return { ok: true };
}

/* ----------------------------------------------- requests for a 2nd person */

export const RequestAdjustment = z.strictObject({ account: z.string().regex(/^[A-Za-z0-9_-]{3,80}$/), side: z.enum(["debit", "credit"]), amountKobo: z.number().int().positive(), memo: z.string().min(5).max(200) });

export const requestAdjustment = (actor: Actor, p: z.infer<typeof RequestAdjustment>) =>
  requestApproval({ kind: "ledger_adjustment", makerUid: actor.uid, target: `wallets/${p.account}`, summary: `${p.side} ${p.amountKobo} kobo: ${p.memo}`, payload: p });

export const requestDepositAssign = (actor: Actor, depositId: string, uid: string) =>
  requestApproval({ kind: "deposit_assign", makerUid: actor.uid, target: `deposits/${depositId}`, summary: `Assign deposit to ${uid}`, payload: { depositId, uid } });

export const requestKycTier = (actor: Actor, uid: string, tier: number) =>
  requestApproval({ kind: "kyc_tier", makerUid: actor.uid, target: `users/${uid}`, summary: `Set KYC tier ${tier}`, payload: { uid, tier } });

export const requestRoleGrant = (actor: Actor, uid: string, role: string) =>
  requestApproval({ kind: "role_grant", makerUid: actor.uid, target: `users/${uid}`, summary: `Set staff role ${role}`, payload: { uid, role } });

export const requestReconRelease = (actor: Actor, note: string) =>
  requestApproval({ kind: "recon_release", makerUid: actor.uid, target: "config/switches", summary: `Resume payouts after reconciliation: ${note}`, payload: {} });
