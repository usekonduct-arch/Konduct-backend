import { createHash, createHmac } from "node:crypto";

/**
 * Student IDs are typed many ways (uni/2023/04571, UNI-2023-04571, " UNI 2023 04571").
 * Collapse them to one key so the same card can't register twice (FR-AUTH-02).
 */
export function normalizeStudentId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s/\\._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Firestore doc id for the uniqueness claim on a student ID within a campus. */
export const studentIdKey = (campusId: string, normalized: string) => `${campusId}__${normalized}`;

/** Emails are compared lower-cased and trimmed. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Firestore doc id for anything keyed by email (emails can contain characters ids can't). */
export const emailKey = (email: string) => createHash("sha256").update(normalizeEmail(email)).digest("hex");

/** "adaeze.okafor@uniosun.edu.ng" -> "ad***@uniosun.edu.ng" for admin lists (SEC-DATA-04). */
export function maskEmail(email: string): string {
  const [user, domain] = normalizeEmail(email).split("@");
  if (!user || !domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

/** Keyed hash of a one-time code, so the database never holds the code itself. */
export const codeHash = (code: string, key: string) => createHmac("sha256", key).update(code.toUpperCase()).digest("hex");

export const cleanName = (s: string) => s.trim().replace(/\s+/g, " ");
