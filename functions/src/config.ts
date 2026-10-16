import { defineSecret, defineString } from "firebase-functions/params";

/** Must match AppConfig.functionsRegion in lib/app/app_info.dart of both apps (Konduct-student, Konduct-Driver). */
export const REGION = "europe-west1";

/** Pilot campus. Every record carries a campusId (SRS 2.1). */
export const CAMPUS_ID = "uniosun";
export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ secrets
 * All live in Google Secret Manager (SEC-OPS-02); none are in code or client apps.
 * Set each once with `firebase functions:secrets:set NAME`.
 */

/** Keyed hash for identity secrets we must check but never store, such as driver onboarding codes. */
export const IDENTITY_KEY = defineSecret("IDENTITY_KEY");
/** Signs vehicle QR tokens (SEC-QR-01). Rotating it invalidates every printed sticker. */
export const QR_SIGNING_KEY = defineSecret("QR_SIGNING_KEY");
/** Derives the 6-character offline payment codes (FR-OFF-01). */
export const OFFLINE_CODE_KEY = defineSecret("OFFLINE_CODE_KEY");
/** Bachs secret key: sk_sandbox_... or sk_live_... The prefix picks the API host. */
export const BACHS_API_KEY = defineSecret("BACHS_API_KEY");
/** Bachs webhook signing secret(s). Comma-separate two during a rotation window. */
export const BACHS_WEBHOOK_SECRETS = defineSecret("BACHS_WEBHOOK_SECRETS");

/* ------------------------------------------------------------------ params
 * Non-secret settings, read from functions/.env.<project> at deploy time.
 */

/** Our own Bachs account id (acct_...). Webhooks from anyone else are refused. */
export const BACHS_ACCOUNT_ID = defineString("BACHS_ACCOUNT_ID", { default: "" });
/** Where the hosted checkout returns the rider. Must be public https. */
export const TOPUP_RETURN_URL = defineString("TOPUP_RETURN_URL", { default: "https://konduct.com.ng/topup/done" });
/**
 * Mailbox for Bachs Connect mail about students' and drivers' payout accounts; "{role}" becomes
 * "student" or "driver" and "{uid}" the user id. (The name predates students withdrawing.)
 */
export const DRIVER_CONTACT_EMAIL = defineString("DRIVER_CONTACT_EMAIL", { default: "ops+{role}-{uid}@konduct.com.ng" });

/**
 * Reject calls without a valid App Check token (SEC-APP-02). Read from functions/.env.
 * Leave false only until App Check (Play Integrity) is registered for both Android apps.
 */
export const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === "true";
/** Staff must have completed MFA (FR-AUTH-04). Only switch off in the emulator. */
export const REQUIRE_STAFF_MFA = process.env.REQUIRE_STAFF_MFA !== "false";

/* ------------------------------------------------------------------ money rules
 * All amounts are integer kobo (₦1 = 100 kobo). Tuned here, enforced server-side only.
 */
export const RULES = {
  /** A PIN (or biometric unlock on the device) is needed at or above this payment total. */
  pinThresholdKobo: 50_000, // ₦500
  /** Most passengers on one scan (FR-GRP-01), including the payer. */
  maxPassengers: 6,
  /** A second scan of the same vehicle inside this window must be acknowledged (FR-GRP-02). */
  repeatScanWindowMs: 10 * 60_000,
  /** A preview is honoured this long (SEC-QR-05: one quote, one payment). */
  quoteTtlMs: 2 * 60_000,
  /** Top-up bounds and checkout lifetime. */
  minTopUpKobo: 20_000, // ₦200
  maxTopUpKobo: 5_000_000, // ₦50,000
  checkoutTtlMinutes: 30,
  /** Bachs NGN payout fee (flat, charged on top). Konduct absorbs it (SRS open question 4). */
  payoutFeeKobo: 5_000, // ₦50
  minPayoutKobo: 50_000, // ₦500
  /** First payout to a newly approved bank account waits this long (FR-DRV-05). */
  newPayoutAccountHoldMs: 24 * 3_600_000,
  /** Daily reconciliation halts automatic payouts above this variance (SEC-PAY-07). */
  reconToleranceKobo: 100, // ₦1
  /** Wrong-PIN lockout. */
  pinMaxAttempts: 5,
  pinLockMs: 30 * 60_000,
  /** Payments above this count in 10 minutes trigger a hold (SEC-PAY-05). */
  velocityMaxPays10Min: 8,
  /** Wrong driver onboarding codes before the invite locks and an agent must issue a new one. */
  inviteMaxAttempts: 5,
  /** Dispute review deadline (FR-DSP-02). */
  disputeSlaMs: 72 * 3_600_000,
  /** An offline code is valid this long for the driver to enter (FR-OFF-01). */
  offlineCodeTtlMs: 2 * 3_600_000,
  /** Refunds and manual adjustments above this need a second staff approval (FR-ADM-03). */
  makerCheckerAboveKobo: 500_000, // ₦5,000
  /** Seats on every bus until an admin sets config/fleet. Scans past this are refused. Bikes keep their own capacity. */
  defaultBusSeats: 7,
  /** A bus's scanned seats clear when nobody has scanned for this long (the trip is over)... */
  seatIdleResetMs: 15 * 60_000,
  /** ...and at the latest this long after the trip's first scan. The driver's "New trip" clears them sooner. */
  tripMaxMs: 45 * 60_000,
  /** A bus's park check-in lapses after this long if the driver forgets to tap "Leaving". */
  parkCheckInMs: 2 * 3_600_000,
  /** Highest bus count staff can report for one park. */
  maxParkBuses: 500,
  /** Trip estimates between two landmarks: straight line × roadFactor, at busSpeedKmh, plus stops. */
  roadFactor: 1.35,
  busSpeedKmh: 20,
  tripStopMinutes: 2,
  minTripMinutes: 3,
  /** A rider can rate the driver from the trip's estimated arrival; without a trip route, this long after paying. */
  rateWithoutRouteMs: 20 * 60_000,
  /** ...and until this long after paying. */
  rateWindowMs: 7 * 86_400_000,
  /** Latest ratings a driver sees on their feedback screen. */
  feedbackShown: 30,
  /** "Tell me when a bus is here" lasts this long, at most this many parks at once. */
  parkWatchMs: 90 * 60_000,
  maxParkWatches: 3,
  /** A rider can enter a friend's referral code this long after signing up, before their first ride. */
  referralApplyWindowMs: 14 * 86_400_000,
  /** Highest reward an admin can set for either side of a referral. */
  maxReferralBonusKobo: 200_000, // ₦2,000
} as const;

/** KYC tiers (FR-WAL-06). Tier 1 = phone + student ID. */
export const KYC_LIMITS: Record<number, { maxBalanceKobo: number; dailySpendKobo: number; dailyFundKobo: number; perTxKobo: number }> = {
  1: { maxBalanceKobo: 5_000_000, dailySpendKobo: 1_000_000, dailyFundKobo: 2_000_000, perTxKobo: 300_000 },
  2: { maxBalanceKobo: 30_000_000, dailySpendKobo: 5_000_000, dailyFundKobo: 10_000_000, perTxKobo: 1_000_000 },
};
