import { createHmac } from "node:crypto";

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

/** Keyed hash so phone numbers in Firestore can be matched but not read back. */
export const phoneHash = (e164: string, key: string) => createHmac("sha256", key).update(e164).digest("hex");

/** "+2348031234567" -> "+234 803 *** 4567" for admin lists (SEC-DATA-04). */
export function maskPhone(e164: string): string {
  const d = e164.replace("+234", "");
  return d.length === 10 ? `+234 ${d.slice(0, 3)} *** ${d.slice(6)}` : "***";
}

export const cleanName = (s: string) => s.trim().replace(/\s+/g, " ");
