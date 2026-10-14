/**
 * Attack and integrity tests for the money paths, against the Firestore + Auth emulators
 * (SRS 9.3: concurrency, idempotency, replay, token tampering, failure handling).
 */
import { actorFor, balance, bachsCalls, keyOf, makeDriverWithVehicle, makeRider, onBachs, resetBachs, setPin, uniq, webhook } from "./test/harness";

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { auth, db, stamp } from "./lib/db";
import { isHttpsError } from "./lib/errors";
import { driverAccount, PLATFORM, riderAccount, verifyAccount } from "./ledger/ledger";
import { confirmPayment, previewPayment, undoPayment } from "./domain/pay";
import { createTopUp } from "./domain/funding";
import { handleBachsWebhook } from "./bachs/webhook";
import { setUserStatus, issueVehicleQr, inviteDriver, resetDriverCode } from "./domain/staff";
import { claimDriverAccount } from "./domain/accounts";
import { memberToken } from "./lib/guards";
import { decide } from "./domain/approvals";
import { onPayoutEvent, payoutDriver, setPayoutAccount } from "./domain/payouts";
import { openDispute, resolveDispute, reviewDispute } from "./domain/disputes";
import { reconcile } from "./domain/recon";

const evtId = () => `evt_${uniq("e")}`;

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (isHttpsError(e)) return (e.details as { reason: string }).reason;
    throw e;
  }
};

const pay = async (rider: Awaited<ReturnType<typeof makeRider>>, token: string, opts: { passengers?: number; key?: string; repeat?: boolean; pin?: string } = {}) => {
  const q = await previewPayment(rider.actor, { qr: token, passengers: opts.passengers ?? 1 });
  return confirmPayment(rider.actor, { quoteId: q.quoteId, idempotencyKey: opts.key ?? keyOf(), repeatConfirmed: opts.repeat ?? true, pin: opts.pin });
};

beforeEach(() => resetBachs());

describe("scan to pay", () => {
  test("a payment moves exactly the quoted fare and writes a verifiable ledger", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    await setPin(r.uid, "2580");
    const preview = await previewPayment(r.actor, { qr: d.token, passengers: 3 });
    assert.equal(preview.totalKobo, 60_000);
    assert.equal(preview.driverFirstName, "Tunde");
    assert.equal(preview.needsPin, true);
    const out = await confirmPayment(r.actor, { quoteId: preview.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false, pin: "2580" });
    assert.equal(out.balanceKobo, 40_000);
    assert.equal(await balance(riderAccount(r.uid)), 40_000);
    assert.equal(await balance(driverAccount(d.uid)), 60_000);
    assert.equal(out.rideTokens.length, 3);
    const trips = await db.collection("trips").where("txId", "==", out.txId).get();
    assert.equal(trips.size, 3);
    const feed = await db.doc(`driverFeed/${d.uid}/items/${out.txId}`).get();
    assert.equal(feed.get("riders"), 3);
    assert.deepEqual((await verifyAccount(riderAccount(r.uid))).ok, true);
    assert.deepEqual((await verifyAccount(driverAccount(d.uid))).ok, true);
  });

  test("the same idempotency key never debits twice", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    const key = keyOf();
    const [a, b] = await Promise.all([
      confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: key, repeatConfirmed: false }),
      confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: key, repeatConfirmed: false }).catch((e) => e),
    ]);
    const c = await confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: key, repeatConfirmed: false });
    assert.equal(c.txId, a.txId);
    if (!(b instanceof Error)) assert.equal(b.txId, a.txId);
    assert.equal(await balance(riderAccount(r.uid)), 80_000);
  });

  test("a quote is single-use: a new key can't replay it (SEC-QR-05)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    await confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false });
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "quote_used");
  });

  test("someone else's quote can't be spent (BOLA)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const victim = await makeRider(100_000);
    const thief = await makeRider(100_000);
    const q = await previewPayment(victim.actor, { qr: d.token, passengers: 1 });
    assert.equal(await reason(confirmPayment(thief.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "quote_missing");
    assert.equal(await balance(riderAccount(victim.uid)), 100_000);
  });

  test("parallel scans can never overdraw a wallet", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000); // room for exactly 5
    const quotes = [];
    for (let i = 0; i < 8; i++) quotes.push(await previewPayment(r.actor, { qr: d.token, passengers: 1 }));
    const results = await Promise.allSettled(quotes.map((q) => confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true })));
    const ok = results.filter((x) => x.status === "fulfilled").length;
    assert.equal(ok, 5);
    assert.equal(await balance(riderAccount(r.uid)), 0);
    assert.equal(await balance(driverAccount(d.uid)), 100_000);
    for (const x of results) if (x.status === "rejected") assert.ok(isHttpsError(x.reason) && ["insufficient_funds"].includes((x.reason.details as any).reason));
    assert.equal((await verifyAccount(riderAccount(r.uid))).ok, true);
  });

  test("insufficient balance never partially debits and offers the top-up path", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(30_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 2 });
    assert.equal(q.insufficient, true);
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "insufficient_funds");
    assert.equal(await balance(riderAccount(r.uid)), 30_000);
  });

  test("a second scan of the same vehicle must be acknowledged (FR-GRP-02)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    await pay(r, d.token, { repeat: false });
    const q2 = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    assert.equal(q2.recentlyPaidThisVehicle, true);
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q2.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "repeat_scan");
    await confirmPayment(r.actor, { quoteId: q2.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true });
    assert.equal(await balance(riderAccount(r.uid)), 60_000);
  });

  test("forged, altered and replaced stickers are refused before any debit", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    assert.equal(await reason(previewPayment(r.actor, { qr: d.token.slice(0, -2) + "AA", passengers: 1 })), "bad_code");
    assert.equal(await reason(previewPayment(r.actor, { qr: "K1.someothervehicle.1.AAAAAAAAAAAAAAAAAAAAAA", passengers: 1 })), "bad_code");
    const staff = actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });
    const reissued = await issueVehicleQr(staff, d.vehicleId);
    assert.equal(await reason(previewPayment(r.actor, { qr: d.token, passengers: 1 })), "sticker_revoked");
    const ok = await previewPayment(r.actor, { qr: reissued.token, passengers: 1 });
    assert.equal(ok.stickerChangedRecently, true);
  });

  test("a quote dies if the sticker is replaced between preview and confirm", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    await issueVehicleQr(actorFor(uniq("adm"), "admin", { role: "admin", status: "active" }), d.vehicleId);
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "vehicle_changed");
    assert.equal(await balance(riderAccount(r.uid)), 100_000);
  });

  test("a fare change between preview and confirm is refused (FR-PAY-09)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    await db.doc(`routes/${d.routeId}`).update({ fareKobo: 30_000, fareVersion: 2 });
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "fare_changed");
  });

  test("a suspended rider or driver can't pay or be paid, instantly (FR-ADM-02)", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    const staff = actorFor(uniq("sup"), "support", { role: "support", status: "active" });
    await setUserStatus(staff, r.uid, "suspended", "lost phone");
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "account_locked");
    const r2 = await makeRider(100_000);
    const q2 = await previewPayment(r2.actor, { qr: d.token, passengers: 1 });
    await setUserStatus(staff, d.uid, "suspended", "investigation");
    assert.equal(await reason(confirmPayment(r2.actor, { quoteId: q2.quoteId, idempotencyKey: keyOf(), repeatConfirmed: false })), "driver_inactive");
  });

  test("big payments need the right PIN, and 5 wrong tries lock it", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(500_000);
    await setPin(r.uid, "2580");
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 3 }); // ₦600 >= ₦500
    assert.equal(q.needsPin, true);
    const attempt = (pin?: string) => confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true, pin });
    assert.equal(await reason(attempt()), "pin_required");
    for (let i = 0; i < 4; i++) assert.equal(await reason(attempt("1397")), "pin_wrong");
    assert.equal(await reason(attempt("1397")), "pin_locked");
    assert.equal(await reason(attempt("2580")), "pin_locked"); // even the right PIN, until the lock lapses
    assert.equal(await balance(riderAccount(r.uid)), 500_000);
  });

  test("daily spend limits count group payments in full (FR-GRP-06)", async () => {
    const d = await makeDriverWithVehicle(300_000); // ₦3,000 fare: tier-1 daily cap is ₦10,000
    const r = await makeRider(2_000_000);
    await setPin(r.uid, "2580");
    await pay(r, d.token, { passengers: 1, pin: "2580" });
    await pay(r, d.token, { passengers: 1, pin: "2580" });
    await pay(r, d.token, { passengers: 1, pin: "2580" });
    const q = await previewPayment(r.actor, { qr: d.token, passengers: 1 });
    assert.equal(await reason(confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true, pin: "2580" })), "over_daily_limit");
  });

  test("undo works once, inside 60 seconds, by reversal", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const out = await pay(r, d.token);
    const u = await undoPayment(r.actor, out.txId);
    assert.equal(u.balanceKobo, 100_000);
    assert.equal(await balance(driverAccount(d.uid)), 0);
    assert.equal(await reason(undoPayment(r.actor, out.txId)), "not_undoable");
    const other = await makeRider(0);
    assert.equal(await reason(undoPayment(other.actor, out.txId)), "bad_tx");
    assert.equal((await db.doc(`ledgerTx/${out.txId}`).get()).get("reversedBy"), `undo_${out.txId}`);
  });
});

describe("funding via Bachs", () => {
  const paidCheckout = (topupId: string, amount = "2000.00", extra: Record<string, unknown> = {}) => ({
    checkout_id: "chk_test123",
    status: "completed",
    payment_status: "paid",
    reference: topupId,
    amount,
    currency: "NGN",
    metadata: { topupId },
    charge: { id: "ch_test123", amount, currency: "NGN", status: "succeeded", settlement_amount: (Number(amount) - 30).toFixed(2) },
    ...extra,
  });

  async function openTopUp(r: Awaited<ReturnType<typeof makeRider>>, amountKobo = 200_000) {
    onBachs("POST", "/v1/checkout-sessions", () => ({ json: { checkout_id: "chk_test123", checkout_url: "https://checkout.bachs.io/c/x", status: "open" } }));
    const t = await createTopUp(r.actor, { amountKobo, idempotencyKey: keyOf() });
    const call = bachsCalls.find((c) => c.path === "/v1/checkout-sessions")!;
    assert.equal(call.body.pricing.amount, "2000.00");
    assert.equal(call.body.reference, t.topupId);
    assert.equal(call.headers["idempotency-key"], t.topupId);
    assert.deepEqual(call.body.payment_method_types, ["NGN_CARD", "NGN_BANK_TRANSFER"]);
    return t;
  }

  const event = (id: string, topupId: string, type = "collection.succeeded") => ({
    id,
    type,
    organization_id: "acct_konduct",
    data: { checkout_id: "chk_test123", reference: topupId, payment_status: "paid", status: "SUCCEEDED", amount: "2000.00", currency: "NGN" },
  });

  test("a signed, API-confirmed top-up credits exactly once, whatever arrives and however often", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout(t.topupId) }));
    const e1 = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(e1.req, e1.res);
    assert.equal(e1.res.code, 200);
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
    assert.equal(await balance(PLATFORM.bachsFees) >= 3_000, true);

    const again = webhook(JSON.parse(e1.req.rawBody.toString()));
    await handleBachsWebhook(again.req, again.res); // redelivery of the same event
    const other = webhook(event(evtId(), t.topupId, "checkout.completed"));
    await handleBachsWebhook(other.req, other.res); // the sibling event
    assert.equal(other.res.code, 200);
    assert.equal(await balance(riderAccount(r.uid)), 200_000);
    assert.equal((await verifyAccount(riderAccount(r.uid))).ok, true);
  });

  test("forged, tampered and stale webhooks are refused with 400 and credit nothing", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout(t.topupId) }));
    for (const w of [
      webhook(event(evtId(), t.topupId), { secret: "whsec_attacker" }),
      webhook(event(evtId(), t.topupId), { tamper: true }),
      webhook(event(evtId(), t.topupId), { ts: Math.floor(Date.now() / 1000) - 3600 }),
    ]) {
      await handleBachsWebhook(w.req, w.res);
      assert.equal(w.res.code, 400);
      assert.equal(w.res.text, "invalid signature");
    }
    assert.equal(await balance(riderAccount(r.uid)), 0);
  });

  test("a genuine event is still not trusted: the API must agree (SEC-PAY-03)", async () => {
    const r = await makeRider(0);
    const t = await openTopUp(r);
    // The webhook says paid; Bachs's API says the checkout is still open.
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: { ...paidCheckout(t.topupId), status: "open", payment_status: "unpaid" } }));
    const w = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(w.req, w.res);
    assert.equal(w.res.code, 200, "a genuine delivery is acknowledged");
    assert.equal(await balance(riderAccount(r.uid)), 0);
    // A checkout that belongs to another reference, or another currency, is not credited either.
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: paidCheckout("tu_someoneelse") }));
    const w2 = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(w2.req, w2.res);
    onBachs("GET", "/v1/checkout-sessions/", () => ({ json: { ...paidCheckout(t.topupId), charge: { id: "c", amount: "2000.00", currency: "USD", status: "succeeded" } } }));
    const w3 = webhook(event(evtId(), t.topupId));
    await handleBachsWebhook(w3.req, w3.res);
    assert.equal(w2.res.code, 200);
    assert.equal(w3.res.code, 200);
    assert.equal(await balance(riderAccount(r.uid)), 0);
    const flags = await db.collection("flags").where("topupId", "==", t.topupId).get();
    assert.ok(flags.docs.some((f) => f.get("type") === "topup_reference_mismatch"));
    assert.ok(flags.docs.some((f) => f.get("type") === "topup_currency_mismatch"));
  });

  test("events from accounts that aren't ours are refused", async () => {
    const w = webhook({ id: evtId(), type: "collection.succeeded", organization_id: "acct_stranger", data: {} });
    await handleBachsWebhook(w.req, w.res);
    assert.equal(w.res.code, 400);
    assert.equal(w.res.text, "unknown account");
  });

  test("bank deposits: funding code credits the rider, unknown senders go to suspense", async () => {
    const r = await makeRider(0, { fundingCode: "KDTEST01" });
    await db.doc("fundingCodes/KDTEST01").set({ uid: r.uid, ...stamp() });
    const dep = (id: string, narration: string | null, acct = "0123456789") => ({
      id,
      type: "collection.succeeded",
      organization_id: "acct_konduct",
      data: {
        charge_id: uniq("ch_"),
        checkout_id: null,
        status: "SUCCEEDED",
        amount: "5000.00",
        currency: "NGN",
        settlement_amount: "4950.00",
        payment_method_details: { type: "bank_transfer", bank_transfer: { sender_name: "ADA OKAFOR", sender_bank_code: "058", sender_account_number: acct, narration, virtual_account: { type: "permanent" } } },
      },
    });
    const w1 = webhook(dep(evtId(), "kd test01 transport"));
    await handleBachsWebhook(w1.req, w1.res);
    assert.equal(await balance(riderAccount(r.uid)), 500_000);
    // Same sender, no narration this time: recognised from the first deposit.
    const w2 = webhook(dep(evtId(), null));
    await handleBachsWebhook(w2.req, w2.res);
    assert.equal(await balance(riderAccount(r.uid)), 1_000_000);
    // A stranger with no code: parked, never guessed.
    const before = await balance(PLATFORM.suspense);
    const w3 = webhook(dep(evtId(), "thanks", "9999999999"));
    await handleBachsWebhook(w3.req, w3.res);
    assert.equal((await balance(PLATFORM.suspense)) - before, 500_000);
  });
});

describe("driver payouts via Bachs Connect", () => {
  test("bank account needs a fresh password sign-in + PIN + a second person; then pays out once", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(500_000);
    for (let i = 0; i < 4; i++) await pay(r, d.token, { repeat: true }); // driver earns ₦800
    await setPin(d.uid, "2580");

    onBachs("POST", "/v1/accounts", () => ({ json: { id: "acct_driver1" } }));
    onBachs("POST", "/v1/accounts/acct_driver1", () => ({ json: { id: "acct_driver1" } }));
    onBachs("GET", "/v1/payouts/destinations", () => ({ json: { data: [{ id: "pd_1", is_usable: true, status: "approved", account_name: "ADEBAYO TUNDE", account_number: "******6789", bank_code: "058" }] } }));
    onBachs("GET", "/v1/payouts/destinations/pd_1", () => ({ json: { id: "pd_1", is_usable: true, status: "approved" } }));

    const stale = actorFor(d.uid, "driver", d.actor.user, Math.floor(Date.now() / 1000) - 3600);
    assert.equal(await reason(setPayoutAccount(stale, { bankCode: "058", accountNumber: "0123456789", pin: "2580" })), "reauth_required");
    const set = await setPayoutAccount({ ...d.actor, user: (await db.doc(`users/${d.uid}`).get()).data()! }, { bankCode: "058", accountNumber: "0123456789", pin: "2580" });
    assert.equal(set.nameMatches, true);
    assert.equal((await payoutDriver(d.uid, "daily")).status, "no_payout_account");

    const approval = (await db.collection("approvals").where("kind", "==", "payout_account").where("makerUid", "==", d.uid).get()).docs[0];
    const ops = actorFor(uniq("ops"), "ops", { role: "ops", status: "active" });
    assert.equal(await reason(decide({ ...ops, uid: d.uid }, approval.id, "approve")), "same_person");
    await decide(ops, approval.id, "approve");
    assert.equal((await payoutDriver(d.uid, "daily")).status, "new_account_hold"); // FR-DRV-05 24h hold
    const paId = (await db.doc(`users/${d.uid}`).get()).get("payoutAccountId");
    await db.doc(`payoutAccounts/${paId}`).update({ holdUntilMs: Date.now() - 1 });

    onBachs("POST", "/v1/transfers", (b) => ({ json: { id: "tr_1", status: "paid", amount: b.amount, currency: "NGN" } }));
    onBachs("POST", "/v1/payouts", (b) => ({ json: { id: "pay_1", status: "pending", amount: b.amount, fee: "50.00", reference: b.reference } }));
    const run = await payoutDriver(d.uid, "daily");
    assert.equal(run.status, "submitted");
    assert.equal(run.amountKobo, 80_000);
    assert.equal(await balance(driverAccount(d.uid)), 0);
    const transfer = bachsCalls.find((c) => c.path === "/v1/transfers")!;
    assert.equal(transfer.body.amount, "850.00"); // amount + Konduct-paid ₦50 fee
    const payout = bachsCalls.find((c) => c.method === "POST" && c.path === "/v1/payouts")!;
    assert.equal(payout.headers["x-account-id"], "acct_driver1");
    assert.equal(payout.body.amount, "800.00");

    // A second run while one is in flight does nothing.
    assert.equal((await payoutDriver(d.uid, "daily")).status, "payout_in_progress");

    await onPayoutEvent("payout.paid", run.payoutId!, { withdrawal_fee: "50.00" });
    await onPayoutEvent("payout.paid", run.payoutId!, { withdrawal_fee: "50.00" }); // duplicate
    assert.equal((await db.doc(`payouts/${run.payoutId}`).get()).get("status"), "paid");
    assert.equal((await verifyAccount(driverAccount(d.uid))).ok, true);
  });

  test("a payout the bank rejects comes back to the driver's wallet", async () => {
    const d = await makeDriverWithVehicle(60_000);
    const r = await makeRider(500_000);
    await setPin(r.uid, "2580");
    await pay(r, d.token, { pin: "2580" });
    await db.runTransaction(async (tx) => {
      const pa = db.collection("payoutAccounts").doc();
      tx.set(pa, { uid: d.uid, bachsAccountId: "acct_d2", destinationId: "pd_2", accountLast4: "1111", status: "active", holdUntilMs: 0, ...stamp() });
      tx.update(db.doc(`users/${d.uid}`), { payoutAccountId: pa.id });
    });
    onBachs("GET", "/v1/payouts/destinations/pd_2", () => ({ json: { id: "pd_2", is_usable: true } }));
    onBachs("POST", "/v1/transfers", (b) => ({ json: { id: uniq("tr_"), status: "paid", amount: b.amount, currency: "NGN" } }));
    onBachs("POST", "/v1/payouts", (b) => ({ json: { id: "pay_2", status: "pending", amount: b.amount, reference: b.reference } }));
    const run = await payoutDriver(d.uid, "driver_request");
    assert.equal(await balance(driverAccount(d.uid)), 0);
    await onPayoutEvent("payout.failed", run.payoutId!, {});
    assert.equal(await balance(driverAccount(d.uid)), 60_000);
    const back = bachsCalls.find((c) => c.path === "/v1/transfers" && c.body.destination === "self");
    assert.ok(back, "money pulled back from the driver's Bachs account");
    assert.equal((await verifyAccount(driverAccount(d.uid))).ok, true);
  });

  test("payouts stop when the kill switch is on", async () => {
    await db.doc("config/switches").set({ payoutsPaused: true });
    try {
      const d = await makeDriverWithVehicle();
      assert.equal((await payoutDriver(d.uid, "daily")).status, "paused");
    } finally {
      await db.doc("config/switches").set({ payoutsPaused: false });
    }
  });
});

describe("driver onboarding by email + agent code", () => {
  const agent = () => actorFor(uniq("agt"), "agent", { role: "agent", status: "active" });
  const routeFor = async () => {
    const id = uniq("route");
    await db.doc(`routes/${id}`).set({ name: "Main Gate → Faculty", stops: ["Main Gate", "Faculty"], fareKobo: 20_000, fareVersion: 1, active: true, ...stamp() });
    return id;
  };
  const invite = async (email: string) =>
    inviteDriver(agent(), {
      email,
      fullName: "Tunde Adebayo",
      plate: "OS 452 KJA",
      type: "shuttle",
      routeId: await routeFor(),
      capacity: 14,
      checks: { idSeen: true, vehiclePapersSeen: true, unionConfirmed: true },
    });
  const newUser = async (email: string) => {
    const uid = uniq("usr");
    await auth.createUser({ uid, email, password: "test-password-1" });
    return uid;
  };

  test("the right code links the driver; the code is never stored", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode, vehicleId } = await invite(email);
    assert.match(onboardingCode, /^[0-9A-Z]{8}$/);
    const stored = (await db.collection("driverInvites").where("email", "==", email).get()).docs[0].data();
    assert.ok(!JSON.stringify(stored).includes(onboardingCode), "only a keyed hash is stored");
    const uid = await newUser(email);
    const out = await claimDriverAccount(uid, email, undefined, onboardingCode.toLowerCase());
    assert.equal(out.invited, true);
    assert.equal((await db.doc(`users/${uid}`).get()).get("role"), "driver");
    assert.equal((await db.doc(`vehicles/${vehicleId}`).get()).get("driverUid"), uid);
    assert.equal((await auth.getUser(uid)).customClaims?.role, "driver");
  });

  test("wrong codes count down, then lock the invite until an agent resets it", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode } = await invite(email);
    const uid = await newUser(email);
    for (let left = 4; left >= 1; left--) {
      const r = await claimDriverAccount(uid, email, undefined, "AAAAAAAA").catch((e) => e);
      assert.equal((r.details as { reason: string }).reason, "code_wrong");
      assert.equal((r.details as { attemptsLeft: number }).attemptsLeft, left);
    }
    assert.equal(await reason(claimDriverAccount(uid, email, undefined, "AAAAAAAA")), "invite_locked");
    assert.equal(await reason(claimDriverAccount(uid, email, undefined, onboardingCode)), "invite_locked"); // even the right one
    const fresh = await resetDriverCode(agent(), email);
    assert.notEqual(fresh.onboardingCode, onboardingCode);
    assert.equal(await reason(claimDriverAccount(uid, email, undefined, onboardingCode)), "code_wrong"); // the old code is dead
    assert.equal((await claimDriverAccount(uid, email, undefined, fresh.onboardingCode)).invited, true);
  });

  test("a claimed invite can't be taken over by another account", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode } = await invite(email);
    const owner = await newUser(email);
    await claimDriverAccount(owner, email, undefined, onboardingCode);
    const intruder = uniq("usr"); // e.g. the same email re-registered after the owner's account was deleted
    assert.equal(await reason(claimDriverAccount(intruder, email, undefined, onboardingCode)), "invite_claimed");
    assert.equal(await reason(resetDriverCode(agent(), email)), "invite_claimed");
  });

  test("an email no agent registered changes nothing", async () => {
    const uid = await newUser(`${uniq("nobody").toLowerCase()}@gmail.com`);
    const out = await claimDriverAccount(uid, "nobody-here@gmail.com", undefined, "KD7F3Q2X");
    assert.deepEqual(out, { invited: false });
    assert.equal((await db.doc(`users/${uid}`).get()).exists, false);
  });

  test("a student account can't claim a driver invite", async () => {
    const email = `${uniq("tunde").toLowerCase()}@gmail.com`;
    const { onboardingCode } = await invite(email);
    assert.equal(await reason(claimDriverAccount(uniq("usr"), email, "rider", onboardingCode)), "wrong_role");
  });

  test("members must sign in with email + password", () => {
    const req = (token: Record<string, unknown>) => ({ auth: { uid: "u1", token } }) as never;
    assert.equal(memberToken(req({ email: "Ada@X.com", firebase: { sign_in_provider: "password" } })).email, "ada@x.com");
    for (const token of [
      { phone_number: "+2348030000000", firebase: { sign_in_provider: "phone" } },
      { firebase: { sign_in_provider: "anonymous" } },
      { email: "ada@x.com", firebase: { sign_in_provider: "custom" } },
    ]) {
      assert.throws(() => memberToken(req(token)), /Sign in with your email/);
    }
    assert.throws(() => memberToken({ auth: undefined } as never), /Sign in with your email/);
  });
});

describe("disputes and books", () => {
  test("a refund reverses the fare; large refunds need a second person", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    const out = await pay(r, d.token);
    await openDispute(r.actor, { txId: out.txId, reason: "charged_twice", note: "scanned twice" });
    assert.equal(await reason(openDispute(r.actor, { txId: out.txId, reason: "other", note: "" })), "dispute_exists");
    const other = await makeRider(0);
    assert.equal(await reason(openDispute(other.actor, { txId: out.txId, reason: "other", note: "" })), "bad_tx");
    const sup = actorFor(uniq("sup"), "support", { role: "support", status: "active" });
    await reviewDispute(sup, out.txId);
    await resolveDispute(sup, { disputeId: out.txId, outcome: "refund", note: "duplicate confirmed" });
    assert.equal(await balance(riderAccount(r.uid)), 100_000);
    assert.equal(await balance(driverAccount(d.uid)), 0);
  });

  test("tampering with a ledger entry is detected", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const r = await makeRider(100_000);
    await pay(r, d.token);
    assert.equal((await verifyAccount(riderAccount(r.uid))).ok, true);
    const entry = (await db.collection("ledgerEntries").where("account", "==", riderAccount(r.uid)).orderBy("seq").limit(1).get()).docs[0];
    await entry.ref.update({ amountKobo: entry.get("amountKobo") + 1 });
    const v = await verifyAccount(riderAccount(r.uid));
    assert.equal(v.ok, false);
  });

  test("reconciliation halts payouts when the books and Bachs disagree", async () => {
    onBachs("GET", "/v1/balances", () => ({ json: { balances: [{ currency: "NGN", available_balance: "1.00" }] } }));
    const report = await reconcile();
    assert.equal(report.ok, false);
    assert.equal((await db.doc("config/switches").get()).get("payoutsHaltedByRecon"), true);
    await db.doc("config/switches").set({ payoutsHaltedByRecon: false }, { merge: true });
  });
});

