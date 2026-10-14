import type { CallableRequest } from "firebase-functions/v2/https";

import { REQUIRE_STAFF_MFA } from "../config";
import { db, FieldValue, millis } from "./db";
import { fail } from "./errors";

export const MEMBER_ROLES = ["rider", "driver"] as const;
export const STAFF_ROLES = ["admin", "ops", "agent", "marshal", "support", "auditor"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type StaffRole = (typeof STAFF_ROLES)[number];
export type Role = MemberRole | StaffRole;

export type Actor = {
  uid: string;
  role: Role;
  phone: string | null;
  /** Seconds since epoch of the last real sign-in (OTP or password+MFA), not token refresh. */
  authTime: number;
  ip: string | null;
  user: FirebaseFirestore.DocumentData;
};

function ipOf(req: CallableRequest): string | null {
  const fwd = req.rawRequest?.headers?.["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.rawRequest?.ip || null;
}

/**
 * Authenticates the caller and loads their profile. The profile's `status` and `role` are read
 * fresh from Firestore on every call, so a suspension takes effect instantly (FR-ADM-02) even
 * though custom claims in an already-issued token can lag by up to an hour.
 */
async function load(req: CallableRequest, allowed: readonly Role[]): Promise<Actor> {
  const token = req.auth?.token;
  if (!req.auth || !token) fail("unauthenticated", "signed_out", "Please sign in again.");
  const claimRole = token.role as Role | undefined;
  if (!claimRole || !allowed.includes(claimRole)) fail("permission-denied", "wrong_role", "You can't do that from this account.");

  const snap = await db.doc(`users/${req.auth.uid}`).get();
  const user = snap.data();
  if (!user) fail("permission-denied", "no_profile", "Finish setting up your account first.");
  if (user.role !== claimRole) fail("permission-denied", "role_changed", "Your account changed. Sign out and back in.");
  if (user.status !== "active") fail("permission-denied", "account_locked", "This account is on hold. Talk to a Konduct agent or support.");

  return { uid: req.auth.uid, role: claimRole, phone: (token.phone_number as string) ?? null, authTime: Number(token.auth_time ?? 0), ip: ipOf(req), user };
}

/** Riders and drivers: verified phone number required (SEC-AUTH-01). */
export async function requireMember(req: CallableRequest, roles: readonly MemberRole[]): Promise<Actor> {
  if (!req.auth?.token?.phone_number) fail("unauthenticated", "no_phone", "Sign in with your phone number first.");
  return load(req, roles);
}

/** Staff: email sign-in plus a completed second factor (FR-AUTH-04, SEC-AUTH-03). */
export async function requireStaff(req: CallableRequest, roles: readonly StaffRole[]): Promise<Actor> {
  const fb = req.auth?.token?.firebase as { sign_in_second_factor?: string; sign_in_provider?: string } | undefined;
  if (REQUIRE_STAFF_MFA && !fb?.sign_in_second_factor) fail("permission-denied", "mfa_required", "Staff actions need two-step sign-in.");
  if (!req.auth?.token?.email_verified) fail("permission-denied", "email_unverified", "Verify your staff email first.");
  return load(req, roles);
}

/**
 * For actions that change where money can go (new bank account, new device): the person must
 * have completed an SMS code within [maxAgeSec] (re-authentication, FR-DRV-05, SEC-AUTH-03).
 */
export function requireRecentSignIn(actor: Actor, maxAgeSec = 300) {
  if (Date.now() / 1000 - actor.authTime > maxAgeSec) {
    fail("failed-precondition", "reauth_required", "For your safety, confirm it's you with a fresh SMS code first.");
  }
}

/**
 * Fixed-window rate limit per person and action (SEC-APP-04, SEC-AUTH-04), held in Firestore so
 * it applies across every function instance.
 */
export async function rateLimit(key: string, bucket: string, max: number, windowMs: number) {
  const ref = db.doc(`rateLimits/${key}__${bucket}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const start = millis(snap.get("windowStart"));
    if (!snap.exists || now - start >= windowMs) {
      tx.set(ref, { windowStart: now, count: 1, expireAt: new Date(now + windowMs * 2) });
      return;
    }
    if ((snap.get("count") as number) >= max) {
      fail("resource-exhausted", "rate_limited", "Too many tries. Wait a moment and try again.", { retryAfterMs: windowMs - (now - start) });
    }
    tx.update(ref, { count: FieldValue.increment(1) });
  });
}
