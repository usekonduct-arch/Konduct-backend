/**
 * Who can use the staff console. An admin adds someone by email: the server makes their account
 * with a one-time password the admin sends them, and on first sign-in the console makes them set
 * up an authenticator and choose their own password. Admins change roles and revoke access
 * directly (no second approval); every change is audited.
 */
import { randomInt } from "node:crypto";
import { z } from "zod";

import { CAMPUS_ID } from "../config";
import { normalizeEmail } from "../identity";
import { audit } from "../lib/audit";
import { auth, db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, STAFF_ROLES, type StaffRole } from "../lib/guards";
import { mergeClaims } from "./accounts";

const staffRole = z.enum(STAFF_ROLES);

export const AddStaff = z.strictObject({
  email: z.string().max(120).transform(normalizeEmail).pipe(z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid email.")),
  role: staffRole,
});

export const SetStaffRole = z.strictObject({ uid: z.string().regex(/^[A-Za-z0-9]{10,128}$/), role: staffRole });

export const StaffUid = z.strictObject({ uid: z.string().regex(/^[A-Za-z0-9]{10,128}$/) });

/** 14 characters from an alphabet without lookalikes (no 0/O, 1/l/I): easy to copy or read out. */
function temporaryPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 14; i++) out += chars[randomInt(chars.length)];
  return out;
}

/** Gives a person a staff role from their next sign-in (old sessions are signed out). */
export async function applyStaffRole(uid: string, role: StaffRole) {
  const user = await auth.getUser(uid);
  await db.doc(`users/${uid}`).set({ role, status: "active", statusReason: null, email: user.email ?? null, ...touched() }, { merge: true });
  await mergeClaims(uid, { role, staff: true, campus: CAMPUS_ID });
  await auth.revokeRefreshTokens(uid);
}

/**
 * New staff: makes (or re-opens) the account for this email and returns a one-time password for
 * the admin to send. The admin vouches for the address, so it is marked verified. Someone already
 * on staff gets a new password instead; a rider or driver email is refused (staff need their own).
 */
export async function addStaff(actor: Actor, input: z.infer<typeof AddStaff>) {
  const password = temporaryPassword();
  let existing = await auth.getUserByEmail(input.email).catch(() => null);
  if (existing) {
    const profile = (await db.doc(`users/${existing.uid}`).get()).data();
    if (profile?.role === "rider" || profile?.role === "driver") {
      fail("failed-precondition", "member_email", "This email belongs to a student or driver account. Staff need a different email.");
    }
    if (existing.uid === actor.uid) fail("failed-precondition", "self", "That's your own account.");
    existing = await auth.updateUser(existing.uid, { password, emailVerified: true, disabled: false });
  }
  const user = existing ?? (await auth.createUser({ email: input.email, password, emailVerified: true }));

  await db.doc(`users/${user.uid}`).set(
    { role: input.role, status: "active", statusReason: null, email: input.email, mustChangePassword: true, addedBy: actor.uid, ...(existing ? touched() : stamp()) },
    { merge: true },
  );
  await mergeClaims(user.uid, { role: input.role, staff: true, campus: CAMPUS_ID });
  await auth.revokeRefreshTokens(user.uid);
  await audit({ actor: actor.uid, action: existing ? "staff.readd" : "staff.add", target: `users/${user.uid}`, after: { email: input.email, role: input.role }, ip: actor.ip });
  return { uid: user.uid, email: input.email, role: input.role, password };
}

/** A fresh one-time password for a staff member who is locked out. */
export async function resetStaffPassword(actor: Actor, uid: string) {
  if (uid === actor.uid) fail("failed-precondition", "self", "Change your own password from the menu instead.");
  const profile = await staffProfile(uid);
  const password = temporaryPassword();
  const user = await auth.updateUser(uid, { password });
  await db.doc(`users/${uid}`).update({ mustChangePassword: true, ...touched() });
  await auth.revokeRefreshTokens(uid);
  await audit({ actor: actor.uid, action: "staff.password.reset", target: `users/${uid}`, after: { role: profile.role }, ip: actor.ip });
  return { uid, email: user.email ?? profile.email, role: profile.role, password };
}

export async function setStaffRole(actor: Actor, uid: string, role: StaffRole) {
  if (uid === actor.uid) fail("failed-precondition", "self", "Another admin has to change your own role.");
  const profile = await staffProfile(uid);
  await applyStaffRole(uid, role);
  await audit({ actor: actor.uid, action: "staff.role", target: `users/${uid}`, before: { role: profile.role }, after: { role }, ip: actor.ip });
  return { role };
}

/** Takes away console access at once: no role, signed out everywhere, and the account can't sign in. */
export async function revokeStaff(actor: Actor, uid: string) {
  if (uid === actor.uid) fail("failed-precondition", "self", "You can't revoke your own access.");
  const profile = await staffProfile(uid);
  await db.doc(`users/${uid}`).set({ role: "none", status: "suspended", statusReason: "access revoked", ...touched() }, { merge: true });
  await mergeClaims(uid, { role: null, staff: false });
  await auth.updateUser(uid, { disabled: true });
  await auth.revokeRefreshTokens(uid);
  await audit({ actor: actor.uid, action: "staff.revoke", target: `users/${uid}`, before: { role: profile.role }, after: { role: "none" }, ip: actor.ip });
  return { revoked: true };
}

/** The console calls this once the person has replaced the one-time password with their own. */
export async function markPasswordChosen(uid: string) {
  await db.doc(`users/${uid}`).update({ mustChangePassword: false, ...touched() });
  return { ok: true };
}

async function staffProfile(uid: string) {
  const snap = await db.doc(`users/${uid}`).get();
  const role = snap.get("role") as string | undefined;
  if (!snap.exists || !(STAFF_ROLES as readonly string[]).includes(role ?? "")) fail("not-found", "not_staff", "That person isn't on staff.");
  return { role: role as StaffRole, email: (snap.get("email") as string | null) ?? null };
}
