/**
 * Sign-up and PIN (FR-AUTH-01..06, FR-AUTH-09). Roles and progress live in custom claims that
 * only this code sets (FR-AUTH-05); Firestore profiles are the source of truth for status.
 */
import { z } from "zod";

import { CAMPUS_ID, IDENTITY_KEY, RULES } from "../config";
import { cleanName, codeHash, emailKey, maskEmail, normalizeStudentId, studentIdKey } from "../identity";
import { audit } from "../lib/audit";
import { randomCode, safeEqual } from "../lib/crypto";
import { auth, db, FieldValue, millis, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { rateLimit } from "../lib/guards";
import { driverAccount, openAccountWrite, riderAccount } from "../ledger/ledger";
import { hashPin, isPinShape, isWeakPin, verifyPin } from "../pin";
import { refreshBoardQuietly } from "./board";

/** Merges into existing custom claims; claims are the app's offline view of role and progress. */
export async function mergeClaims(uid: string, patch: Record<string, unknown>) {
  const current = (await auth.getUser(uid)).customClaims ?? {};
  await auth.setCustomUserClaims(uid, { ...current, ...patch });
}

/**
 * The legal documents' version (konduct-landing/src/content/legal.ts) the person agreed to on the
 * sign-up screen. Optional in the schema so an older app gets a clear "update" message instead of
 * a bare validation error; the sign-up itself refuses to go ahead without it.
 */
export const LegalVersion = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

function requireConsent(version: string | undefined) {
  if (!version) fail("failed-precondition", "update_app", "Update Konduct to finish signing up: you need to agree to the new Terms and Privacy Policy.");
  return { version, acceptedAtMs: Date.now() };
}

export const RegisterRider = z.strictObject({
  legalVersion: LegalVersion,
  fullName: z
    .string()
    .max(120)
    .transform(cleanName)
    .pipe(z.string().min(3, "Enter your full name.").max(80, "That name is too long.").regex(/^[\p{L}'.-]+(\s[\p{L}'.-]+)+$/u, "Enter your first and last name.")),
  studentId: z
    .string()
    .max(40)
    .transform(normalizeStudentId)
    .pipe(z.string().min(4, "Enter your student ID.").max(24, "That student ID is too long.").regex(/^[A-Z0-9-]+$/, "Student IDs use letters, numbers and slashes only."))
    .optional(),
});

/**
 * FR-AUTH-01/02: profile + wallet (+ a claim on the student ID when one is given), in one
 * transaction. The app now asks only for a name; staff can add a student ID later. A clash is
 * refused and flagged for review rather than silently merged.
 */
export async function registerRider(uid: string, email: string, existingRole: unknown, input: z.infer<typeof RegisterRider>) {
  if (existingRole) fail("failed-precondition", "already_registered", "This number already has a Konduct account.");
  await rateLimit(uid, "register", 5, 3_600_000);
  const { fullName, studentId } = input;
  const legal = requireConsent(input.legalVersion);
  const idRef = studentId ? db.doc(`studentIds/${studentIdKey(CAMPUS_ID, studentId)}`) : null;
  const userRef = db.doc(`users/${uid}`);

  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.get(userRef);
    if (existing.exists) return { clash: null, code: existing.get("fundingCode") as string };
    const held = idRef ? await tx.get(idRef) : null;
    if (held?.exists && held.get("uid") !== uid) return { clash: held.get("uid") as string, code: null };

    // A personal code riders put in their transfer narration so deposits find them.
    let code = "";
    for (let i = 0; i < 5 && !code; i++) {
      const c = `KD${randomCode(6)}`;
      if (!(await tx.get(db.doc(`fundingCodes/${c}`))).exists) code = c;
    }
    if (!code) throw new Error("could not allocate a funding code");

    if (idRef) tx.set(idRef, { uid, studentId, ...stamp() });
    tx.set(db.doc(`fundingCodes/${code}`), { uid, ...stamp() });
    tx.set(userRef, {
      role: "rider",
      status: "active",
      fullName,
      ...(studentId ? { studentId } : {}),
      email,
      emailMasked: maskEmail(email),
      kycTier: 1,
      pinSet: false,
      fundingCode: code,
      trustedDevices: [],
      allowOthersToPay: true,
      legal,
      ...stamp(),
    });
    openAccountWrite(tx, riderAccount(uid), "rider", uid);
    audit({ actor: uid, action: "rider.register", target: userRef.path, after: { studentId: studentId ?? null } }, tx);
    return { clash: null, code };
  });

  if (result.clash) {
    await db.collection("flags").add({ type: "duplicate_student_id", studentId, uid, heldBy: result.clash, status: "open", ...stamp() });
    fail("already-exists", "student_id_taken", "That student ID is already on another account. If it's yours, talk to a Konduct agent at the park.");
  }
  await mergeClaims(uid, { role: "rider", campus: CAMPUS_ID, name: fullName, status: "active", pin: false });
  return { ok: true, fundingCode: result.code };
}

/**
 * FR-AUTH-03: links a signed-in account to the invite an agent created at the park for this
 * email. Emails aren't verified yet, so the email alone proves nothing: the driver must also
 * give the one-time code the agent handed over. Five wrong codes lock the invite until an agent
 * issues a new code. With no invite this returns { invited: false } and changes nothing.
 */
export async function claimDriverAccount(uid: string, email: string, existingRole: unknown, rawCode: string, legalVersion?: string) {
  if (existingRole && existingRole !== "driver") fail("failed-precondition", "wrong_role", "This is a student account.");
  await rateLimit(uid, "claim", 10, 3_600_000);
  const legal = requireConsent(legalVersion);
  const code = rawCode.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!/^[0-9A-Z]{8}$/.test(code)) fail("invalid-argument", "bad_code", "Driver codes are 8 letters and numbers.");
  const inviteRef = db.doc(`driverInvites/${emailKey(email)}`);

  type Outcome = { kind: "none" } | { kind: "wrong"; left: number } | { kind: "ok"; d: FirebaseFirestore.DocumentData };
  const result: Outcome = await db.runTransaction(async (tx) => {
    const invite = await tx.get(inviteRef);
    if (!invite.exists || invite.get("status") === "revoked") return { kind: "none" };
    if (invite.get("status") === "claimed") {
      if (invite.get("claimedBy") === uid) return { kind: "ok", d: invite.data()! };
      fail("already-exists", "invite_claimed", "This driver record is already linked to another account. Talk to a Konduct agent.");
    }
    if (invite.get("status") === "locked") fail("permission-denied", "invite_locked", "Too many wrong codes. Ask a Konduct agent for a new one.");

    if (!safeEqual(codeHash(code, IDENTITY_KEY.value()), String(invite.get("codeHash")))) {
      const attempts = (invite.get("attempts") ?? 0) + 1;
      const locked = attempts >= RULES.inviteMaxAttempts;
      tx.update(inviteRef, { attempts, status: locked ? "locked" : "pending", ...touched() });
      if (locked) tx.create(db.collection("flags").doc(), { type: "driver_code_lockout", inviteId: inviteRef.id, uid, status: "open", ...stamp() });
      return { kind: "wrong", left: RULES.inviteMaxAttempts - attempts };
    }

    const d = invite.data()!;
    const vehicle = await tx.get(db.doc(`vehicles/${d.vehicleId}`));
    if (!vehicle.exists) throw new Error("invite points at a missing vehicle");
    tx.set(db.doc(`users/${uid}`), {
      role: "driver",
      status: "active",
      fullName: d.fullName,
      email,
      emailMasked: maskEmail(email),
      contactPhone: d.contactPhone ?? null,
      vehicleId: d.vehicleId,
      onboardedBy: d.onboardedBy,
      pinSet: false,
      trustedDevices: [],
      payoutAccountId: null,
      legal,
      ...stamp(),
    });
    openAccountWrite(tx, driverAccount(uid), "driver", uid);
    tx.update(inviteRef, { status: "claimed", claimedBy: uid, claimedAt: FieldValue.serverTimestamp(), codeHash: null, ...touched() });
    tx.update(vehicle.ref, { driverUid: uid, ...touched() });
    audit({ actor: uid, action: "driver.claim", target: `users/${uid}`, after: { vehicleId: d.vehicleId } }, tx);
    return { kind: "ok", d };
  });

  if (result.kind === "none") return { invited: false };
  if (result.kind === "wrong") {
    if (result.left <= 0) fail("permission-denied", "invite_locked", "Too many wrong codes. Ask a Konduct agent for a new one.");
    fail("permission-denied", "code_wrong", `That code doesn't match. ${result.left} ${result.left === 1 ? "try" : "tries"} left.`, { attemptsLeft: result.left });
  }
  const d = result.d;
  if (existingRole !== "driver") await mergeClaims(uid, { role: "driver", campus: CAMPUS_ID, name: d.fullName, status: "active", pin: false });
  await refreshBoardQuietly(d.vehicleId); // the bus has a driver now: it goes on the riders' board
  return { invited: true, fullName: d.fullName, plate: d.plate, vehicleType: d.vehicleType, route: d.routeName ?? "" };
}

/** FR-AUTH-06: first PIN only. Changing a PIN needs a fresh SMS code + the old PIN (changePin). */
export async function setTransactionPin(uid: string, pin: string) {
  assertGoodPin(pin);
  await rateLimit(uid, "pinset", 5, 3_600_000);
  const pinRef = db.doc(`pins/${uid}`);
  const hashed = await hashPin(pin);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(pinRef)).exists) fail("already-exists", "pin_exists", "You already have a PIN.");
    tx.set(pinRef, { ...hashed, length: pin.length, failedAttempts: 0, lockedUntil: 0, ...stamp() });
    tx.update(db.doc(`users/${uid}`), { pinSet: true, ...touched() });
    audit({ actor: uid, action: "pin.set", target: `users/${uid}`, after: { length: pin.length } }, tx);
  });
  await mergeClaims(uid, { pin: true });
  return { ok: true };
}

export async function changePin(uid: string, oldPin: string, newPin: string) {
  assertGoodPin(newPin);
  await checkPin(uid, oldPin);
  const hashed = await hashPin(newPin);
  await db.runTransaction(async (tx) => {
    tx.update(db.doc(`pins/${uid}`), { ...hashed, length: newPin.length, failedAttempts: 0, lockedUntil: 0, ...touched() });
    audit({ actor: uid, action: "pin.change", target: `users/${uid}` }, tx);
  });
  return { ok: true };
}

function assertGoodPin(pin: string) {
  if (!isPinShape(pin)) fail("invalid-argument", "pin_shape", "Your PIN must be 4 or 6 digits.");
  if (isWeakPin(pin)) fail("invalid-argument", "pin_weak", "That PIN is too easy to guess. Avoid repeats and runs like 1234.");
}

/**
 * Verifies a transaction PIN with lockout: 5 wrong tries locks PIN use for 30 minutes and
 * raises a security flag. A burst limit stops parallel guessing racing the counter.
 */
export async function checkPin(uid: string, pin: unknown): Promise<void> {
  if (typeof pin !== "string" || !isPinShape(pin)) fail("invalid-argument", "pin_required", "Enter your PIN to confirm.", { needsPin: true });
  await rateLimit(uid, "pincheck", 6, 60_000);
  const ref = db.doc(`pins/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) fail("failed-precondition", "no_pin", "Set a PIN first.");
  const lockedUntil = millis(snap.get("lockedUntil"));
  if (lockedUntil > Date.now()) fail("permission-denied", "pin_locked", "Too many wrong PINs. Try again in a little while.", { retryAfterMs: lockedUntil - Date.now() });

  const good = await verifyPin(pin, { hash: snap.get("hash"), salt: snap.get("salt") });
  if (good) {
    if (snap.get("failedAttempts")) await ref.update({ failedAttempts: 0, ...touched() });
    return;
  }
  const attempts = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    // A guess sent alongside the one that locked the PIN passed the check above before the lock
    // existed. It must not count from zero again, or it would write the lock away.
    if (millis(s.get("lockedUntil")) > Date.now()) return RULES.pinMaxAttempts;
    const n = (s.get("failedAttempts") ?? 0) + 1;
    const lock = n >= RULES.pinMaxAttempts;
    tx.update(ref, lock ? { failedAttempts: 0, lockedUntil: Date.now() + RULES.pinLockMs, ...touched() } : { failedAttempts: n, ...touched() });
    if (lock) tx.create(db.collection("flags").doc(), { type: "pin_lockout", uid, status: "open", ...stamp() });
    return n;
  });
  const left = RULES.pinMaxAttempts - attempts;
  if (left <= 0) fail("permission-denied", "pin_locked", "Too many wrong PINs. PIN payments are paused for 30 minutes.");
  fail("permission-denied", "pin_wrong", `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`, { attemptsLeft: left });
}
