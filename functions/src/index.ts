/**
 * Konduct backend: every endpoint the apps and consoles can reach.
 *
 *  Both      supportOpen, supportSend (chat with staff)
 *  Rider     registerRider (email + password sign-in), setTransactionPin, changePin, payPreview, payConfirm, rateDriver,
 *            createTopUp, refreshTopUps, openDispute, lockMyAccount, registerDevice, riderSetPayoutAccount, riderWithdraw, payoutBanks
 *  Both      receiptProof (verify a fare, top-up or payout against the ledger)
 *  Driver    claimDriverAccount (agent's one-time code), (setTransactionPin, changePin, lockMyAccount, registerDevice),
 *            driverConfirmOfflineCode, driverSetPayoutAccount, driverRequestPayout, driverNewTrip, driverSetRoute, driverSetPark, payoutBanks
 *  Staff     staff* (MFA + role checked): onboarding, staff accounts (staffAddStaff, staffRevokeStaff, ...), editing people, QR, routes, parks, landmarks, trip routes, bus seats, support, people, switches,
 *            approvals, disputes, notifications (staffSendNotice, staffSetBroadcast), ads (staffUpsertAd, staffDeleteAd),
 *            images (staffUploadMedia)
 *  Bachs     bachsWebhook (HTTP, signature-verified)
 *  Public    receipt (HTTP GET /receipt/<code>: anyone with a receipt's QR can check it is genuine),
 *            media (HTTP GET /media/<id>: images for ads and notifications)
 *  Jobs      dailyPayoutRun, reconcileDaily, reconcilePayoutsJob, disputeSlaWatch
 */
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";

import { BACHS_API_KEY, BACHS_WEBHOOK_SECRETS, IDENTITY_KEY, OFFLINE_CODE_KEY, QR_SIGNING_KEY, REGION } from "./config";
import { handleBachsWebhook } from "./bachs/webhook";
import { callable, Empty } from "./api/callable";
import { db, stamp } from "./lib/db";
import { fail } from "./lib/errors";
import { JOBS } from "./jobs";
import { memberToken, requireMember, requireStaff } from "./lib/guards";
import { changePin, claimDriverAccount, RegisterRider, registerRider, setTransactionPin } from "./domain/accounts";
import { decide } from "./domain/approvals";
import { OpenDispute, openDispute, ResolveDispute, resolveDispute, reviewDispute } from "./domain/disputes";
import { createTopUp, refreshTopUps, TopUpInput } from "./domain/funding";
import { handleReceiptPage, receiptProof, ReceiptProofInput } from "./domain/receipts";
import { DeleteAd, deleteAd, handleMediaRequest, joinTopic, SendNotice, sendNotice, SetBroadcast, setBroadcastActive, UploadMedia, uploadMedia, UpsertAd, upsertAd } from "./domain/messaging";
import { ConfirmInput, confirmOfflineCode, confirmPayment, previewPayment, PreviewInput } from "./domain/pay";
import { SetParkBuses, setParkBuses, UpsertPark, upsertPark } from "./domain/parks";
import { DriverSetRoute, setVehicleRoute, StaffSetRoute, UpsertLandmark, upsertLandmark } from "./domain/landmarks";
import { RateDriver, rateDriver } from "./domain/ratings";
import { openSupport, replySupport, sendSupport, setSupportStatus, StaffSupportReply, StaffSupportStatus, SupportOpen, SupportSend } from "./domain/support";
import { SetFleet, setFleet, startNewTrip } from "./domain/seats";
import { DriverSetPark, rebuildBoard, refreshBoardQuietly, setVehiclePark, StaffSetPark } from "./domain/board";
import { listBanks, PayoutAccountInput, requestDriverPayout, requestRiderWithdrawal, setPayoutAccount, WithdrawInput } from "./domain/payouts";
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
  UpdateUser,
  updateUserDetails,
  UpsertRoute,
  upsertRoute,
} from "./domain/staff";
import { SetBrand, setBrand } from "./domain/brand";
import { AddStaff, addStaff, markPasswordChosen, resetStaffPassword, revokeStaff, SetStaffRole, setStaffRole, StaffUid } from "./domain/team";

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
    // Group messages from the console go to the role's topic.
    await joinTopic(data.fcmToken, actor.role);
    return { ok: true };
  },
);

/* ----------------------------------------------------------------- support */

/** A rider or driver starts a conversation with Konduct staff. */
export const supportOpen = callable(SupportOpen, async (req, data) => openSupport(await requireMember(req, ["rider", "driver"]), data));

export const supportSend = callable(SupportSend, async (req, data) => sendSupport(await requireMember(req, ["rider", "driver"]), data));

/* ------------------------------------------------------------------ riders */

export const payPreview = callable(PreviewInput, async (req, data) => previewPayment(await requireMember(req, ["rider"]), data), { secrets: [QR_SIGNING_KEY], minInstances: PAY_MIN });

export const payConfirm = callable(ConfirmInput, async (req, data) => confirmPayment(await requireMember(req, ["rider"]), data), { secrets: [OFFLINE_CODE_KEY], minInstances: PAY_MIN });

/**
 * Riders can no longer undo a payment themselves (it was abused to ride for free). App builds from
 * before that still have the button; they get this answer. Wrong vehicle: contact support.
 */
export const payUndo = callable(z.object({}).passthrough(), async (req) => {
  await requireMember(req, ["rider"]);
  fail("failed-precondition", "undo_removed", "Payments can't be undone in the app. If you paid the wrong bus, contact Konduct support from this receipt.");
});

const createTopUp_ = callable(TopUpInput, async (req, data) => createTopUp(await requireMember(req, ["rider"]), data), { secrets: [BACHS_API_KEY] });

/** Pull-to-refresh: re-reads the rider's open checkouts from Bachs in case a webhook is late. */
const refreshTopUps_ = callable(Empty, async (req) => refreshTopUps(await requireMember(req, ["rider"])), { secrets: [BACHS_API_KEY] });

/** After the trip's estimated time: 1 to 5 stars for the driver, once per ride. */
const rateDriver_ = callable(RateDriver, async (req, data) => rateDriver(await requireMember(req, ["rider"]), data));

const openDispute_ = callable(OpenDispute, async (req, data) => openDispute(await requireMember(req, ["rider"]), data));

/** Students add a bank account (fresh sign-in + PIN, second-person approval) and withdraw their wallet to it. */
export const riderSetPayoutAccount = callable(PayoutAccountInput, async (req, data) => setPayoutAccount(await requireMember(req, ["rider"]), data), {
  secrets: [BACHS_API_KEY],
});

export const riderWithdraw = callable(WithdrawInput, async (req, data) => requestRiderWithdrawal(await requireMember(req, ["rider"]), data), {
  secrets: [BACHS_API_KEY],
});

/** The bank picker in both apps. */
export const payoutBanks = callable(Empty, async (req) => {
  await requireMember(req, ["rider", "driver"]);
  return listBanks();
}, { secrets: [BACHS_API_KEY] });

/** Proof from the ledger for one of the caller's own fares, top-ups or payouts. */
const receiptProof_ = callable(ReceiptProofInput, async (req, data) => receiptProof(await requireMember(req, ["rider", "driver"]), data));

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

/** The bus has emptied: clear the seats paid by scan so the next riders can pay. */
export const driverNewTrip = callable(Empty, async (req) => {
  const actor = await requireMember(req, ["driver"]);
  const out = await startNewTrip(actor);
  await refreshBoardQuietly(actor.user.vehicleId as string | undefined);
  return out;
});

/** The bus has arrived at a park (parkId) or is leaving it (null): riders see it on the board. */
export const driverSetPark = callable(DriverSetPark, async (req, data) => {
  const actor = await requireMember(req, ["driver"]);
  return setVehiclePark(actor, actor.user.vehicleId as string | undefined, data.parkId);
});

/** Where the bus goes on this trip (from one landmark to another); newTrip also clears the seats. */
export const driverSetRoute = callable(DriverSetRoute, async (req, data) => {
  const actor = await requireMember(req, ["driver"]);
  const route = await setVehicleRoute(actor, actor.user.vehicleId as string | undefined, data);
  await refreshBoardQuietly(actor.user.vehicleId as string | undefined);
  return route;
});

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

export const staffUpsertPark = callable(UpsertPark, async (req, data) => upsertPark(await requireStaff(req, ["ops", "admin"]), data));

/** Whoever is at the park keeps its bus count current. */
export const staffSetParkBuses = callable(SetParkBuses, async (req, data) => setParkBuses(await requireStaff(req, ["agent", "marshal", "ops", "admin"]), data));

/** Seats on every bus; scans past it are refused. */
export const staffUpsertLandmark = callable(UpsertLandmark, async (req, data) => upsertLandmark(await requireStaff(req, ["admin"]), data));

/** Staff at the park help a driver change their trip route. */
export const staffSetVehicleRoute = callable(StaffSetRoute, async (req, data) => {
  const { vehicleId, ...route } = data;
  const out = await setVehicleRoute(await requireStaff(req, ["agent", "marshal", "ops", "admin"]), vehicleId, route);
  await refreshBoardQuietly(vehicleId);
  return out;
});

/** Staff at the park check a bus in or out for its driver. */
export const staffSetVehiclePark = callable(StaffSetPark, async (req, data) =>
  setVehiclePark(await requireStaff(req, ["agent", "marshal", "ops", "admin"]), data.vehicleId, data.parkId),
);

export const staffSupportReply = callable(StaffSupportReply, async (req, data) => replySupport(await requireStaff(req, ["support", "ops", "admin"]), data));

export const staffSupportSetStatus = callable(StaffSupportStatus, async (req, data) => setSupportStatus(await requireStaff(req, ["support", "ops", "admin"]), data));

export const staffSetFleet = callable(SetFleet, async (req, data) => {
  const out = await setFleet(await requireStaff(req, ["admin"]), data);
  await rebuildBoard(); // every bus's seat count changed
  return out;
});

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

/** An admin corrects a rider's or driver's name, email, student ID or phone. */
export const staffUpdateUser = callable(UpdateUser, async (req, data) => updateUserDetails(await requireStaff(req, ["admin"]), data));

/** Staff accounts: the admin adds someone by email and sends them the one-time password returned here. */
export const staffAddStaff = callable(AddStaff, async (req, data) => addStaff(await requireStaff(req, ["admin"]), data));

export const staffResetStaffPassword = callable(StaffUid, async (req, data) => resetStaffPassword(await requireStaff(req, ["admin"]), data.uid));

export const staffSetStaffRole = callable(SetStaffRole, async (req, data) => setStaffRole(await requireStaff(req, ["admin"]), data.uid, data.role));

export const staffRevokeStaff = callable(StaffUid, async (req, data) => revokeStaff(await requireStaff(req, ["admin"]), data.uid));

/**
 * First sign-in: the new staff member has replaced the one-time password with their own. It only
 * clears a flag on the caller's own profile, so it skips the two-step check: a password change can
 * hand the console a fresh token that no longer carries the second-factor mark.
 */
export const staffPasswordChosen = callable(Empty, async (req) => {
  if (!req.auth || req.auth.token.staff !== true) fail("permission-denied", "wrong_role", "You can't do that from this account.");
  return markPasswordChosen(req.auth.uid);
});

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

/** Messages to one person or a whole group: inbox, popup and/or push. */
export const staffSendNotice = callable(SendNotice, async (req, data) => sendNotice(await requireStaff(req, ["ops", "admin"]), data));

export const staffSetBroadcast = callable(SetBroadcast, async (req, data) => setBroadcastActive(await requireStaff(req, ["ops", "admin"]), data));

/** The social handles and hashtag the apps put in captions when someone shares a ride or their Wrapped. */
export const staffSetBrand = callable(SetBrand, async (req, data) => setBrand(await requireStaff(req, ["ops", "admin"]), data));

/** Carousel and popup ads in the apps. */
export const staffUpsertAd = callable(UpsertAd, async (req, data) => upsertAd(await requireStaff(req, ["ops", "admin"]), data));

export const staffDeleteAd = callable(DeleteAd, async (req, data) => deleteAd(await requireStaff(req, ["ops", "admin"]), data));

/** One image for an ad or a notification (the console resizes it first). */
export const staffUploadMedia = callable(UploadMedia, async (req, data) => uploadMedia(await requireStaff(req, ["ops", "admin"]), data));

export const staffResolveDispute = callable(ResolveDispute, async (req, data) => resolveDispute(await requireStaff(req, ["support", "ops", "admin"]), data));

/* ------------------------------------------------------------------- Bachs */

export const bachsWebhook = onRequest(
  { region: REGION, secrets: [BACHS_WEBHOOK_SECRETS, BACHS_API_KEY], memory: "256MiB", timeoutSeconds: 30, maxInstances: 20, cors: false },
  handleBachsWebhook,
);

/** The public receipt check the QR on every receipt opens. Read-only; shows no names or balances. */
export const receipt = onRequest({ region: REGION, memory: "256MiB", timeoutSeconds: 15, maxInstances: 10, cors: false }, handleReceiptPage);

/** Images for ads and notifications. */
export const media = onRequest({ region: REGION, memory: "256MiB", timeoutSeconds: 15, maxInstances: 10, cors: false }, handleMediaRequest);

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
  refreshTopUps_ as refreshTopUps,
  receiptProof_ as receiptProof,
  openDispute_ as openDispute,
  rateDriver_ as rateDriver,
};
