/**
 * One-off: turns on authenticator-app (TOTP) two-step sign-in for staff (FR-AUTH-04). Firebase has
 * no console switch for TOTP, so it's set through the Identity Toolkit admin API. The project must
 * first be upgraded to "Firebase Authentication with Identity Platform" in the Firebase console.
 *
 *   FIREBASE_SERVICE_ACCOUNT="$(cat key.json)" npm run enable-totp
 */
import { getApp } from "firebase-admin/app";

import "../lib/db"; // initializes the app with the service-account key

async function main() {
  const app = getApp();
  const projectId = app.options.projectId;
  const credential = app.options.credential;
  if (!projectId || !credential) throw new Error("Set FIREBASE_SERVICE_ACCOUNT (or GOOGLE_APPLICATION_CREDENTIALS) to the service-account key.");
  const { access_token } = await credential.getAccessToken();
  const res = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config?updateMask=mfa`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", "x-goog-user-project": projectId },
    body: JSON.stringify({ mfa: { state: "ENABLED", providerConfigs: [{ state: "ENABLED", totpProviderConfig: { adjacentIntervals: 5 } }] } }),
  });
  const body = (await res.json()) as { error?: { message?: string } };
  if (!res.ok) {
    const msg = body.error?.message ?? res.statusText;
    if (msg.includes("upgraded")) throw new Error("Upgrade the project to Firebase Authentication with Identity Platform first (Firebase console → Authentication → Settings).");
    throw new Error(msg);
  }
  console.log(`Authenticator-app sign-in is on for ${projectId}.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
