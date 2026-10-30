/**
 * Staff operations (FR-ADM-01/02, FR-AUTH-03/09, FR-DRV-08, FR-PAY-09, SEC-OPS-05). Every call is
 * already MFA-checked and role-checked by the API layer; every change is audited with before/after.
 */
import { z } from "zod";

import { CAMPUS_ID, IDENTITY_KEY, QR_SIGNING_KEY } from "../config";
import { audit } from "../lib/audit";
import { randomCode } from "../lib/crypto";
import { auth, db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import type { Actor } from "../lib/guards";
import { cleanName, codeHash, emailKey, maskEmail, normalizeEmail, normalizeStudentId, studentIdKey } from "../identity";
import { mergeClaims } from "./accounts";
import { refreshBoardQuietly } from "./board";
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
  email: z.string().max(120).transform(normalizeEmail).pipe(z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid email.")),
  contactPhone: e164.optional(),
  fullName: z.string().max(80).transform(cleanName).pipe(z.string().regex(/^[\p{L}'.-]+(\s[\p{L}'.-]+)+$/u)),
  plate: z.string().max(16).transform((s) => s.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z0-9 -]{5,16}$/)),
  type: z.enum(["shuttle", "bike"]),
  routeId: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/),
  /** Bikes only. Buses all seat config/fleet.busSeats, which an admin sets once for the fleet. */
  capacity: z.number().int().min(1).max(30).optional(),
  checks: z.strictObject({ idSeen: z.literal(true), vehiclePapersSeen: z.literal(true), unionConfirmed: z.literal(true) }),
});

/**
 * FR-AUTH-03: an agent onboards a driver at the park after checking ID, papers and union. The
 * returned onboarding code is shown to the agent once, handed to the driver in person, and
 * stored only as a keyed hash.
 */
export async function inviteDriver(actor: Actor, input: z.infer<typeof InviteDriver>) {
  const inviteRef = db.doc(`driverInvites/${emailKey(input.email)}`);
  const onboardingCode = randomCode(8);
  const vehicleRef = db.collection("vehicles").doc();
  await db.runTransaction(async (tx) => {
    const [existing, route] = await tx.getAll(inviteRef, db.doc(`routes/${input.routeId}`));
    if (existing.exists && existing.get("status") !== "revoked") fail("already-exists", "invite_exists", "This email already has a driver record.");
    if (!route.exists) fail("not-found", "no_route", "Unknown route.");
    tx.set(vehicleRef, {
      plate: input.plate,
      type: input.type,
      capacity: input.type === "bike" ? (input.capacity ?? 1) : null,
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
      email: input.email,
      emailMasked: maskEmail(input.email),
      contactPhone: input.contactPhone ?? null,
      codeHash: codeHash(onboardingCode, IDENTITY_KEY.value()),
      attempts: 0,
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
  return { vehicleId: vehicleRef.id, onboardingCode };
}

/** A fresh onboarding code for a driver who lost theirs or locked the invite with wrong tries. */
export async function resetDriverCode(actor: Actor, email: string) {
  const inviteRef = db.doc(`driverInvites/${emailKey(email)}`);
  const onboardingCode = randomCode(8);
  await db.runTransaction(async (tx) => {
    const invite = await tx.get(inviteRef);
    if (!invite.exists || invite.get("status") === "revoked") fail("not-found", "no_invite", "No driver record for that email.");
    if (invite.get("status") === "claimed") fail("failed-precondition", "invite_claimed", "This driver has already linked their account.");
    tx.update(inviteRef, { codeHash: codeHash(onboardingCode, IDENTITY_KEY.value()), attempts: 0, status: "pending", ...touched() });
    audit({ actor: actor.uid, action: "driver.code.reset", target: inviteRef.path, before: { status: invite.get("status") }, after: { status: "pending" }, ip: actor.ip }, tx);
  });
  return { onboardingCode };
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
    return { version, shortCode, plate: v.get("plate") as string, type: v.get("type") as "shuttle" | "bike" | undefined };
  });
  return { token: makeVehicleToken(QR_SIGNING_KEY.value(), vehicleId, out.version), shortCode: out.shortCode, plate: out.plate, type: out.type };
}

export async function setVehicleStatus(actor: Actor, vehicleId: string, status: "active" | "suspended" | "retired") {
  const ref = db.doc(`vehicles/${vehicleId}`);
  await db.runTransaction(async (tx) => {
    const v = await tx.get(ref);
    if (!v.exists) fail("not-found", "no_vehicle", "Unknown vehicle.");
    tx.update(ref, { status, ...touched() });
    audit({ actor: actor.uid, action: "vehicle.status", target: ref.path, before: { status: v.get("status") }, after: { status }, ip: actor.ip }, tx);
  });
  await refreshBoardQuietly(vehicleId);
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

export const UpdateUser = z.strictObject({
  uid: z.string().regex(/^[A-Za-z0-9]{10,128}$/),
  fullName: z.string().max(80).transform(cleanName).pipe(z.string().regex(/^[\p{L}'.-]+(\s[\p{L}'.-]+)+$/u, "Enter a first and last name.")).optional(),
  email: z.string().max(120).transform(normalizeEmail).pipe(z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid email.")).optional(),
  studentId: z.string().max(40).transform(normalizeStudentId).pipe(z.string().regex(/^[A-Z0-9-]{4,24}$/, "Student IDs use letters, numbers and dashes.")).optional(),
  contactPhone: e164.nullable().optional(),
});

/**
 * An admin corrects a rider's or driver's details. The sign-in email changes too (the person
 * signs in with the new one from now on), a student ID keeps its one-account claim, and the name
 * on the app updates at their next sign-in.
 */
export async function updateUserDetails(actor: Actor, input: z.infer<typeof UpdateUser>) {
  const { uid, ...patch } = input;
  const ref = db.doc(`users/${uid}`);
  const u = await ref.get();
  if (!u.exists) fail("not-found", "no_user", "Unknown person.");
  const role = u.get("role") as string;
  if (role !== "rider" && role !== "driver") fail("failed-precondition", "not_member", "Staff details are managed on the Staff page.");
  if (patch.studentId !== undefined && role !== "rider") fail("invalid-argument", "not_rider", "Only students have a student ID.");

  const changes: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== (u.get(k) ?? null)) {
      changes[k] = v;
      before[k] = u.get(k) ?? null;
    }
  }
  if (!Object.keys(changes).length) return { changed: [] };

  if (typeof changes.email === "string") {
    const taken = await auth.getUserByEmail(changes.email).catch(() => null);
    if (taken && taken.uid !== uid) fail("already-exists", "email_taken", "Another account already uses that email.");
    await auth.updateUser(uid, { email: changes.email });
    changes.emailMasked = maskEmail(changes.email);
  }

  await db.runTransaction(async (tx) => {
    if (typeof changes.studentId === "string") {
      const newRef = db.doc(`studentIds/${studentIdKey(CAMPUS_ID, changes.studentId)}`);
      const held = await tx.get(newRef);
      if (held.exists && held.get("uid") !== uid) fail("already-exists", "student_id_taken", "That student ID is already on another account.");
      if (before.studentId) tx.delete(db.doc(`studentIds/${studentIdKey(CAMPUS_ID, String(before.studentId))}`));
      tx.set(newRef, { uid, studentId: changes.studentId, ...stamp() });
    }
    tx.update(ref, { ...changes, ...touched() });
    audit({ actor: actor.uid, action: "user.edit", target: ref.path, before, after: changes, ip: actor.ip }, tx);
  });
  if (typeof changes.fullName === "string") {
    await mergeClaims(uid, { name: changes.fullName });
    if (role === "driver") await refreshBoardQuietly(u.get("vehicleId") as string | undefined);
  }
  return { changed: Object.keys(changes).filter((k) => k !== "emailMasked") };
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

export const requestDepositAssign = (actor: Actor, depositId: string, uid: string, to: "rider" | "cash" = "rider") =>
  requestApproval({
    kind: "deposit_assign",
    makerUid: actor.uid,
    target: `deposits/${depositId}`,
    summary: to === "cash" ? `Count deposit as cash banked by ${uid}` : `Assign deposit to ${uid}`,
    payload: { depositId, uid, to },
  });

/** The deposit is Konduct's own income, such as an advertiser's payment: a second person approves. */
export const requestDepositIncome = (actor: Actor, depositId: string, category: string) =>
  requestApproval({
    kind: "deposit_assign",
    makerUid: actor.uid,
    target: `deposits/${depositId}`,
    summary: `Count deposit as Konduct income (${category})`,
    payload: { depositId, to: "income", category },
  });

export const requestKycTier = (actor: Actor, uid: string, tier: number) =>
  requestApproval({ kind: "kyc_tier", makerUid: actor.uid, target: `users/${uid}`, summary: `Set KYC tier ${tier}`, payload: { uid, tier } });

export const requestRoleGrant = (actor: Actor, uid: string, role: string) =>
  requestApproval({ kind: "role_grant", makerUid: actor.uid, target: `users/${uid}`, summary: `Set staff role ${role}`, payload: { uid, role } });

export const requestReconRelease = (actor: Actor, note: string) =>
  requestApproval({ kind: "recon_release", makerUid: actor.uid, target: "config/switches", summary: `Resume payouts after reconciliation: ${note}`, payload: {} });
