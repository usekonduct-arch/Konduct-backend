import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { cert, getApps, initializeApp, type AppOptions } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

import { CAMPUS_ID, SCHEMA_VERSION } from "../config";

/**
 * On Render the service-account key comes from FIREBASE_SERVICE_ACCOUNT (the key's JSON as an environment
 * variable) or a secret file named by GOOGLE_APPLICATION_CREDENTIALS. It is read up front, so a missing or
 * malformed key stops the server with the reason instead of failing every sign-in.
 * Cloud Functions sets neither and uses its own credentials.
 */
function credentialOptions(): AppOptions | undefined {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (inline) {
    // Keep Google libraries from looking for a key file that may not exist.
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    return fromJson(inline, "FIREBASE_SERVICE_ACCOUNT");
  }
  if (!path) return undefined;
  try {
    return fromJson(readFileSync(path, "utf8"), path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!code) throw e;
    // Names only, never contents: shows whether the secret file was mounted under another name.
    let present = "nothing";
    try {
      present = readdirSync(dirname(path)).join(", ") || "nothing";
    } catch {}
    throw new Error(`cannot read service-account key at ${path} (${code}); ${dirname(path)} holds: ${present}`);
  }
}

function fromJson(text: string, source: string): AppOptions {
  let key: { project_id?: string; client_email?: string; private_key?: string };
  try {
    key = JSON.parse(text);
  } catch {
    // Don't echo the parse error: it quotes the input, which holds the private key.
    throw new Error(`service-account key in ${source} is not valid JSON`);
  }
  if (!key.project_id || !key.client_email || !key.private_key) throw new Error(`service-account key in ${source} is missing fields`);
  return { credential: cert(key as Parameters<typeof cert>[0]), projectId: key.project_id };
}

if (!getApps().length) initializeApp(credentialOptions());

export const db: Firestore = getFirestore();
export const auth = getAuth();
export { FieldValue, Timestamp };

/** Fields every document carries (SRS 5). */
export const stamp = () => ({
  campusId: CAMPUS_ID,
  createdAt: FieldValue.serverTimestamp(),
  updatedAt: FieldValue.serverTimestamp(),
  schemaVersion: SCHEMA_VERSION,
});

export const touched = () => ({ updatedAt: FieldValue.serverTimestamp() });

/** "2026-10-14" in Lagos time, for daily limits and runs (campus days, not UTC days). */
export function lagosDay(at = Date.now()): string {
  return new Date(at + 3_600_000).toISOString().slice(0, 10);
}

export const millis = (v: unknown): number => (v instanceof Timestamp ? v.toMillis() : typeof v === "number" ? v : 0);
