import { HttpsError, type FunctionsErrorCode } from "firebase-functions/v2/https";

/**
 * Errors the app shows to a person. `reason` is a stable machine code the app can branch on
 * (for example "insufficient_funds" to show the top-up shortcut, FR-PAY-08); `message` is
 * written for the rider or driver. Never put internal detail in either.
 */
export function fail(code: FunctionsErrorCode, reason: string, message: string, extra?: Record<string, unknown>): never {
  throw new HttpsError(code, message, { reason, ...extra });
}

export const isHttpsError = (e: unknown): e is HttpsError => e instanceof HttpsError;
