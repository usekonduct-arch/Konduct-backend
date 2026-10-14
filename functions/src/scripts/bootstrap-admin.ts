/**
 * One-off: makes the FIRST admin. After that, roles are granted only through staffGrantRole,
 * which needs a second admin to approve (FR-ADM-03). Refuses to run if any admin exists.
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
  const existing = await db.collection("users").where("role", "==", "admin").limit(1).get();
  if (!existing.empty) throw new Error("An admin already exists. Use staffGrantRole (needs a second admin's approval).");
  const user = await auth.getUserByEmail(values.email);
  if (!user.emailVerified) throw new Error("Verify this email address first.");
  await db.doc(`users/${user.uid}`).set({ role: "admin", status: "active", email: user.email, ...stamp() }, { merge: true });
  await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), role: "admin", staff: true, campus: CAMPUS_ID });
  await auth.revokeRefreshTokens(user.uid);
  await db.collection("auditLogs").add({ actor: "script:bootstrap-admin", action: "role.bootstrap", target: `users/${user.uid}`, before: null, after: { role: "admin" }, ip: null, ts: FieldValue.serverTimestamp(), campusId: CAMPUS_ID });
  console.log(`${values.email} is now the first admin. Sign out and back in, with MFA, to use it.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
