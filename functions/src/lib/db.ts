import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

import { CAMPUS_ID, SCHEMA_VERSION } from "../config";

if (!getApps().length) initializeApp();

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
