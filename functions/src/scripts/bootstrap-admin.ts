/**
 * One-off: makes the two founding admins. Granting a role needs a second admin to approve
 * (FR-ADM-03), so with one admin nobody could ever approve the next. After two exist, roles are
 * granted only through staffGrantRole in the console. Refuses to run once there are two admins.
 *
 *   npm run bootstrap-admin -- --email you@konduct.app
 *
 * The person must already have an email/password account with a verified email, and must
 * enrol a second factor (SMS or TOTP) before staff endpoints will accept them (FR-AUTH-04).
 * Needs credentials for the project: `gcloud auth application-default login` + GCLOUD_PROJECT.
 */
import { parseArgs } from "node:util";

import { CAMPUS_ID } from "../config";
import { auth, db, FieldValue, stamp } from "../lib/db";

const { values } = parseArgs({ options: { email: { type: "string" } } });

async function main() {
  if (!values.email) throw new Error("--email is required");
  const existing = await db.collection("users").where("role", "==", "admin").limit(2).get();
  if (existing.size >= 2) throw new Error("Two admins already exist. Grant roles from the staff console (needs a second admin's approval).");
  const user = await auth.getUserByEmail(values.email);
  if (!user.emailVerified) throw new Error("Verify this email address first.");
  if (existing.docs.some((d) => d.id === user.uid)) throw new Error("This person is already an admin.");
  const profile = (await db.doc(`users/${user.uid}`).get()).data();
  if (profile?.role === "rider" || profile?.role === "driver") throw new Error("This email is a rider or driver account. Staff need their own email.");
  await db.doc(`users/${user.uid}`).set({ role: "admin", status: "active", email: user.email, ...stamp() }, { merge: true });
  await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), role: "admin", staff: true, campus: CAMPUS_ID });
  await auth.revokeRefreshTokens(user.uid);
  await db.collection("auditLogs").add({ actor: "script:bootstrap-admin", action: "role.bootstrap", target: `users/${user.uid}`, before: null, after: { role: "admin" }, ip: null, ts: FieldValue.serverTimestamp(), campusId: CAMPUS_ID });
  console.log(`${values.email} is now admin ${existing.size + 1} of 2. Sign out and back in, with two-step sign-in, to use it.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
