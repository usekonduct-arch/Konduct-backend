import { readFileSync } from "node:fs";
import { cert, getApps, initializeApp, type AppOptions } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

import { CAMPUS_ID, SCHEMA_VERSION } from "../config";

/**
 * On Render the service-account key is a secret file named by GOOGLE_APPLICATION_CREDENTIALS. Read it up front,
 * so a missing, unreadable or malformed file stops the server with the reason instead of failing every sign-in.
 * Cloud Functions has no such variable and uses its own credentials.
 */
function credentialOptions(): AppOptions | undefined {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read service-account key at ${path} (${(e as NodeJS.ErrnoException).code})`);
  }
  let key: { project_id?: string; client_email?: string; private_key?: string };
  try {
    key = JSON.parse(text);
  } catch {
    // Don't echo the parse error: it quotes the file, which holds the private key.
    throw new Error(`service-account key at ${path} is not valid JSON`);
  }
  if (!key.project_id || !key.client_email || !key.private_key) throw new Error(`service-account key at ${path} is missing fields`);
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
