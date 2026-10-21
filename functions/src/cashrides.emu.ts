/**
 * Cash rides at the park (domain/cashrides.ts), against the Firestore + Auth emulators: an agent
 * takes a visitor's cash and pays the bus, then hands the cash in.
 */
import { actorFor, balance, keyOf, makeDriverWithVehicle, uniq } from "./test/harness";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { db, stamp } from "./lib/db";
import { isHttpsError } from "./lib/errors";
import { agentAccount, driverAccount, PLATFORM, prepare, verifyAccount } from "./ledger/ledger";
import { confirmCashRide, myCash, previewCashRide, receiveCash } from "./domain/cashrides";
import { lookUpReceipt } from "./domain/receipts";
import { decide } from "./domain/approvals";
import { requestDepositAssign } from "./domain/staff";

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (isHttpsError(e)) return (e.details as { reason: string }).reason;
    throw e;
  }
};

const agent = () => {
  const uid = uniq("agt");
  return actorFor(uid, "agent", { role: "agent", status: "active", fullName: "Bola Agent" });
};
const admin = () => actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });

const sell = async (a: ReturnType<typeof agent>, vehicleId: string, passengers = 1, key = keyOf()) => {
  const p = await previewCashRide(a, { vehicleId, passengers });
  return confirmCashRide(a, { vehicleId, passengers, totalKobo: p.totalKobo, idempotencyKey: key });
};

/** An unmatched bank transfer, as the deposit webhook leaves it. */
async function unmatchedDeposit(amountKobo: number) {
  const id = uniq("ch_");
  await db.runTransaction(async (tx) => {
    const l = await prepare(tx, {
      txId: `deposit_${id}`,
      type: "deposit.unmatched",
      legs: [
        { account: PLATFORM.bachsFloat, side: "debit", amountKobo },
        { account: PLATFORM.suspense, side: "credit", amountKobo },
      ],
    });
    l.commit();
    tx.set(db.doc(`deposits/${id}`), { chargeId: id, amountKobo, status: "unmatched", uid: null, ...stamp() });
  });
  return id;
}

describe("cash rides at the park", () => {
  test("an agent sells a ride for cash: the driver is paid and alerted, the agent owes the cash", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const a = agent();
    const p = await previewCashRide(a, { qr: d.token, passengers: 2 });
    assert.equal(p.vehicleId, d.vehicleId);
    assert.equal(p.totalKobo, 40_000);
    assert.equal(p.driverFirstName, "Tunde");
    assert.equal(p.cashHeldKobo, 0);

    const key = keyOf();
    const out = await confirmCashRide(a, { vehicleId: d.vehicleId, passengers: 2, totalKobo: 40_000, idempotencyKey: key });
    assert.equal(out.cashHeldKobo, 40_000);
    assert.equal(await balance(driverAccount(d.uid)), 40_000);
    assert.equal(await balance(agentAccount(a.uid)), 40_000);
    assert.equal((await verifyAccount(agentAccount(a.uid))).ok, true);
    assert.equal((await verifyAccount(driverAccount(d.uid))).ok, true);

    const feed = await db.doc(`driverFeed/${d.uid}/items/${out.txId}`).get();
    assert.equal(feed.get("riders"), 2);
    assert.equal(feed.get("via"), "cash");
    const t = await db.doc(`transactions/${out.txId}`).get();
    assert.equal(t.get("channel"), "cash");
    assert.equal(t.get("payerUid"), null);
    assert.equal(t.get("agentUid"), a.uid);
    assert.equal((await db.doc(`vehicles/${d.vehicleId}`).get()).get("load.taken"), 2);

    // The visitor's ticket checks out against the ledger.
    const code = out.verifyUrl!.split("/receipt/")[1];
    const r = await lookUpReceipt(code);
    assert.equal(r?.genuine, true);
    assert.equal(r?.amountKobo, 40_000);
    assert.equal(r?.reference, out.reference);

    // A retry with the same key gives the same ticket and never pays twice.
    const again = await confirmCashRide(a, { vehicleId: d.vehicleId, passengers: 2, totalKobo: 40_000, idempotencyKey: key });
    assert.equal(again.txId, out.txId);
    assert.equal(await balance(driverAccount(d.uid)), 40_000);

    const mine = await myCash(a);
    assert.equal(mine.cashHeldKobo, 40_000);
    assert.equal(mine.sales[0].reference, out.reference);
  });

  test("a fare change between preview and confirm is refused; stickers by code work too", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const a = agent();
    // Real sticker codes avoid O, I and L (cleanCode reads them as 0 and 1); the fixture's may not.
    const code = `C${Date.now().toString(36).slice(-5).toUpperCase().replace(/[OIL]/g, "7")}`;
    await db.doc(`vehicles/${d.vehicleId}`).update({ shortCode: code });
    const p = await previewCashRide(a, { code, passengers: 1 });
    await db.doc(`routes/${d.routeId}`).update({ fareKobo: 25_000, fareVersion: 2 });
    assert.equal(await reason(confirmCashRide(a, { vehicleId: p.vehicleId, passengers: 1, totalKobo: p.totalKobo, idempotencyKey: keyOf() })), "fare_changed");
    assert.equal(await balance(driverAccount(d.uid)), 0);
  });

  test("an agent can't hold more than the cash limit, and nothing moves when refused", async () => {
    const d = await makeDriverWithVehicle(500_000); // ₦5,000 a seat, so the ₦20,000 limit comes quickly
    const a = agent();
    for (let i = 0; i < 4; i++) {
      await sell(a, d.vehicleId);
      await db.doc(`vehicles/${d.vehicleId}`).update({ load: null }); // a new trip each time
    }
    assert.equal(await balance(agentAccount(a.uid)), 2_000_000);
    assert.equal(await reason(sell(a, d.vehicleId)), "cash_limit");
    assert.equal(await balance(driverAccount(d.uid)), 2_000_000);
  });

  test("a suspended vehicle or paused payments refuse a cash ride", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const a = agent();
    await db.doc(`vehicles/${d.vehicleId}`).update({ status: "suspended" });
    assert.equal(await reason(previewCashRide(a, { vehicleId: d.vehicleId, passengers: 1 })), "vehicle_inactive");
    assert.equal(await reason(confirmCashRide(a, { vehicleId: d.vehicleId, passengers: 1, totalKobo: 20_000, idempotencyKey: keyOf() })), "vehicle_inactive");
  });

  test("ops takes cash from an agent in person: the debt moves, and never more than was held", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const a = agent();
    const ops = actorFor(uniq("ops"), "ops", { role: "ops", status: "active" });
    await sell(a, d.vehicleId, 3);
    assert.equal(await reason(receiveCash(ops, { fromUid: a.uid, amountKobo: 70_000 })), "more_than_held");
    const r = await receiveCash(ops, { fromUid: a.uid, amountKobo: 60_000 });
    assert.equal(r.theirCashKobo, 0);
    assert.equal(r.yourCashKobo, 60_000);
    assert.equal(await balance(agentAccount(ops.uid)), 60_000);
    assert.equal((await verifyAccount(agentAccount(ops.uid))).ok, true);
  });

  test("banked cash, matched to the agent from Deposits, clears what they owe", async () => {
    const d = await makeDriverWithVehicle(20_000);
    const a = agent();
    const boss = admin();      // the maker: requests the assignment
    const checker = admin();   // a second person approves it (no self-approval)
    await sell(a, d.vehicleId, 2); // owes ₦400

    const tooMuch = await unmatchedDeposit(50_000);
    const big = await requestDepositAssign(boss, tooMuch, a.uid, "cash");
    assert.equal(await reason(decide(checker, big.approvalId, "approve")), "more_than_held");
    assert.equal((await db.doc(`deposits/${tooMuch}`).get()).get("status"), "unmatched");

    const suspenseBefore = await balance(PLATFORM.suspense);
    const right = await unmatchedDeposit(40_000);
    const ok = await requestDepositAssign(boss, right, a.uid, "cash");
    await decide(checker, ok.approvalId, "approve");
    assert.equal(await balance(agentAccount(a.uid)), 0);
    assert.equal(await balance(PLATFORM.suspense), suspenseBefore);
    assert.equal((await db.doc(`deposits/${right}`).get()).get("matchedBy"), "staff_cash");
  });
});
