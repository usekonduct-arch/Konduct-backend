/**
 * Konduct backend: every endpoint the apps and consoles can reach.
 *
 *  Rider     registerRider (email + password sign-in), setTransactionPin, changePin, payPreview, payConfirm, payUndo,
 *            createTopUp, openDispute, lockMyAccount, registerDevice
 *  Driver    claimDriverAccount (agent's one-time code), (setTransactionPin, changePin, lockMyAccount, registerDevice),
 *            driverConfirmOfflineCode, driverSetPayoutAccount, driverRequestPayout
 *  Staff     staff* (MFA + role checked): onboarding, QR, routes, people, switches, approvals,
 *            disputes
 *  Bachs     bachsWebhook (HTTP, signature-verified)
 *  Jobs      dailyPayoutRun, reconcileDaily, reconcilePayoutsJob, disputeSlaWatch
 */
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";

import { BACHS_API_KEY, BACHS_WEBHOOK_SECRETS, IDENTITY_KEY, OFFLINE_CODE_KEY, QR_SIGNING_KEY, REGION } from "./config";
import { handleBachsWebhook } from "./bachs/webhook";
import { callable, Empty } from "./api/callable";
import { db, stamp } from "./lib/db";
import { JOBS } from "./jobs";
import { memberToken, requireMember, requireStaff } from "./lib/guards";
import { changePin, claimDriverAccount, RegisterRider, registerRider, setTransactionPin } from "./domain/accounts";
import { decide } from "./domain/approvals";
import { OpenDispute, openDispute, ResolveDispute, resolveDispute, reviewDispute } from "./domain/disputes";
import { createTopUp, TopUpInput } from "./domain/funding";
import { ConfirmInput, confirmOfflineCode, confirmPayment, previewPayment, PreviewInput, undoPayment } from "./domain/pay";
import { PayoutAccountInput, requestDriverPayout, setPayoutAccount } from "./domain/payouts";
import {
  InviteDriver,
  inviteDriver,
  issueVehicleQr,
  lockMyAccount,
  requestAdjustment,
  RequestAdjustment,
  requestDepositAssign,
  requestKycTier,
  requestReconRelease,
  requestRoleGrant,
  resetDriverCode,
  setSwitches,
  SetSwitches,
  setUserStatus,
  setVehicleStatus,
  UpsertRoute,
  upsertRoute,
} from "./domain/staff";

const PAY_MIN = Number(process.env.MIN_INSTANCES_PAY ?? 0); // 1 in production: no cold start on the pay path

/* ---------------------------------------------------------------- sign-up */

/** Before a role exists: an email + password sign-in is all that's required. */
const registerRider_ = callable(RegisterRider, async (req, data) => {
  const { uid, email, role } = memberToken(req);
  return registerRider(uid, email, role, data);
});

const claimDriverAccount_ = callable(z.strictObject({ code: z.string().max(16) }), async (req, data) => {
  const { uid, email, role } = memberToken(req);
  return claimDriverAccount(uid, email, role, data.code);
}, { secrets: [IDENTITY_KEY] });

const setTransactionPin_ = callable(z.strictObject({ pin: z.string().max(6) }), async (req, data) => {
  const actor = await requireMember(req, ["rider", "driver"]);
  return setTransactionPin(actor.uid, data.pin);
});

const changePin_ = callable(z.strictObject({ oldPin: z.string().max(6), newPin: z.string().max(6) }), async (req, data) => {
  const actor = await requireMember(req, ["rider", "driver"]);
  return changePin(actor.uid, data.oldPin, data.newPin);
});

const lockMyAccount_ = callable(Empty, async (req) => lockMyAccount(await requireMember(req, ["rider", "driver"])));

const registerDevice_ = callable(
  z.strictObject({ deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), fcmToken: z.string().min(20).max(4096), platform: z.enum(["android", "ios"]) }),
  async (req, data) => {
    const actor = await requireMember(req, ["rider", "driver"]);
    await db.doc(`users/${actor.uid}/devices/${data.deviceId}`).set({ fcmToken: data.fcmToken, platform: data.platform, active: true, lastSeenAtMs: Date.now(), ...stamp() }, { merge: true });
    return { ok: true };
  },
);

/* ------------------------------------------------------------------ riders */

export const payPreview = callable(PreviewInput, async (req, data) => previewPayment(await requireMember(req, ["rider"]), data), { secrets: [QR_SIGNING_KEY], minInstances: PAY_MIN });

export const payConfirm = callable(ConfirmInput, async (req, data) => confirmPayment(await requireMember(req, ["rider"]), data), { secrets: [OFFLINE_CODE_KEY], minInstances: PAY_MIN });

export const payUndo = callable(z.strictObject({ txId: z.string().max(60) }), async (req, data) => undoPayment(await requireMember(req, ["rider"]), data.txId));

const createTopUp_ = callable(TopUpInput, async (req, data) => createTopUp(await requireMember(req, ["rider"]), data), { secrets: [BACHS_API_KEY] });

const openDispute_ = callable(OpenDispute, async (req, data) => openDispute(await requireMember(req, ["rider"]), data));

/* ----------------------------------------------------------------- drivers */

export const driverConfirmOfflineCode = callable(z.strictObject({ code: z.string().max(12) }), async (req, data) =>
  confirmOfflineCode(await requireMember(req, ["driver"]), data.code),
);

export const driverSetPayoutAccount = callable(PayoutAccountInput, async (req, data) => setPayoutAccount(await requireMember(req, ["driver"]), data), {
  secrets: [BACHS_API_KEY],
});

export const driverRequestPayout = callable(z.strictObject({ pin: z.string().max(6) }), async (req, data) =>
  requestDriverPayout(await requireMember(req, ["driver"]), data.pin), { secrets: [BACHS_API_KEY] },
);

/* ------------------------------------------------------------------- staff */

const uidField = z.string().regex(/^[A-Za-z0-9]{10,128}$/);
const idField = z.string().regex(/^[A-Za-z0-9_-]{6,80}$/);

export const staffInviteDriver = callable(InviteDriver, async (req, data) => inviteDriver(await requireStaff(req, ["agent", "ops", "admin"]), data), {
  secrets: [IDENTITY_KEY],
});

export const staffResetDriverCode = callable(z.strictObject({ email: z.string().max(120) }), async (req, data) =>
  resetDriverCode(await requireStaff(req, ["agent", "ops", "admin"]), data.email), { secrets: [IDENTITY_KEY] },
);

export const staffIssueVehicleQr = callable(z.strictObject({ vehicleId: idField }), async (req, data) =>
  issueVehicleQr(await requireStaff(req, ["agent", "ops", "admin"]), data.vehicleId), { secrets: [QR_SIGNING_KEY] },
);

export const staffSetVehicleStatus = callable(z.strictObject({ vehicleId: idField, status: z.enum(["active", "suspended", "retired"]) }), async (req, data) =>
  setVehicleStatus(await requireStaff(req, ["ops", "admin"]), data.vehicleId, data.status),
);

export const staffUpsertRoute = callable(UpsertRoute, async (req, data) => upsertRoute(await requireStaff(req, ["ops", "admin"]), data));

export const staffSetUserStatus = callable(z.strictObject({ uid: uidField, status: z.enum(["active", "suspended"]), reason: z.string().min(3).max(200) }), async (req, data) =>
  setUserStatus(await requireStaff(req, ["support", "agent", "ops", "admin"]), data.uid, data.status, data.reason),
);

export const staffSetSwitches = callable(SetSwitches, async (req, data) => setSwitches(await requireStaff(req, ["admin"]), data));

export const staffRequestAdjustment = callable(RequestAdjustment, async (req, data) => requestAdjustment(await requireStaff(req, ["ops", "admin"]), data));

export const staffAssignDeposit = callable(z.strictObject({ depositId: idField, uid: uidField }), async (req, data) =>
  requestDepositAssign(await requireStaff(req, ["ops", "admin", "support"]), data.depositId, data.uid),
);

export const staffSetKycTier = callable(z.strictObject({ uid: uidField, tier: z.number().int().min(1).max(2) }), async (req, data) =>
  requestKycTier(await requireStaff(req, ["ops", "admin"]), data.uid, data.tier),
);

export const staffGrantRole = callable(z.strictObject({ uid: uidField, role: z.enum(["admin", "ops", "agent", "marshal", "support", "auditor", "none"]) }), async (req, data) =>
  requestRoleGrant(await requireStaff(req, ["admin"]), data.uid, data.role),
);

export const staffRequestReconRelease = callable(z.strictObject({ note: z.string().min(10).max(300) }), async (req, data) =>
  requestReconRelease(await requireStaff(req, ["admin"]), data.note),
);

export const staffDecideApproval = callable(
  z.strictObject({ approvalId: idField, decision: z.enum(["approve", "reject"]), note: z.string().max(300).optional() }),
  async (req, data) => decide(await requireStaff(req, ["ops", "admin"]), data.approvalId, data.decision, data.note),
  { secrets: [BACHS_API_KEY] },
);

export const staffReviewDispute = callable(z.strictObject({ disputeId: idField }), async (req, data) =>
  reviewDispute(await requireStaff(req, ["support", "ops", "admin"]), data.disputeId),
);

export const staffResolveDispute = callable(ResolveDispute, async (req, data) => resolveDispute(await requireStaff(req, ["support", "ops", "admin"]), data));

/* ------------------------------------------------------------------- Bachs */

export const bachsWebhook = onRequest(
  { region: REGION, secrets: [BACHS_WEBHOOK_SECRETS, BACHS_API_KEY], memory: "256MiB", timeoutSeconds: 30, maxInstances: 20, cors: false },
  handleBachsWebhook,
);

/* -------------------------------------------------------------------- jobs */

const job = { region: REGION, timeZone: "Africa/Lagos", secrets: [BACHS_API_KEY], timeoutSeconds: 540, memory: "512MiB" as const, retryCount: 1 };

export const dailyPayoutRun = onSchedule({ ...job, schedule: "30 21 * * *" }, () => JOBS.dailyPayoutRun().then(() => {}));

export const reconcileDaily = onSchedule({ ...job, schedule: "30 2 * * *" }, () => JOBS.reconcileDaily().then(() => {}));

export const reconcilePayoutsJob = onSchedule({ ...job, schedule: "every 15 minutes", timeoutSeconds: 300 }, () => JOBS.reconcilePayoutsJob().then(() => {}));

export const disputeSlaWatch = onSchedule({ ...job, schedule: "0 * * * *", secrets: [] }, () => JOBS.disputeSlaWatch().then(() => {}));

/*
 * Public names. The `_` suffix above avoids clashing with the imported domain functions;
 * these are the names the apps call.
 */
export {
  registerRider_ as registerRider,
  claimDriverAccount_ as claimDriverAccount,
  setTransactionPin_ as setTransactionPin,
  changePin_ as changePin,
  lockMyAccount_ as lockMyAccount,
  registerDevice_ as registerDevice,
  createTopUp_ as createTopUp,
  openDispute_ as openDispute,
};
