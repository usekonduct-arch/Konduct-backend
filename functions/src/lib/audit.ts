import type { Transaction } from "firebase-admin/firestore";

import { CAMPUS_ID } from "../config";
import { db, FieldValue } from "./db";

export type AuditEntry = {
  actor: string; // uid, "system:<job>", "bachs:webhook" or "script:<name>"
  action: string; // "pay.confirm", "admin.user.suspend", ...
  target: string; // document path the action touched
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
};

/**
 * Append-only audit log (FR-ADM-05). Rules deny every client read and write; no code path
 * updates or deletes these documents. Pass a transaction to commit it with the change itself.
 */
export function audit(e: AuditEntry, tx?: Transaction) {
  const ref = db.collection("auditLogs").doc();
  const doc = { ...e, before: e.before ?? null, after: e.after ?? null, ip: e.ip ?? null, ts: FieldValue.serverTimestamp(), campusId: CAMPUS_ID };
  if (tx) tx.create(ref, doc);
  else return ref.create(doc);
}
