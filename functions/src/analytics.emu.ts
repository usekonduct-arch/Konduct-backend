/**
 * Analytics, against the Firestore + Auth emulators. The figures must equal what really happened:
 * rides and money from real payments, profit from real postings and typed-in lines, and income
 * from a deposit only after a second person approves it.
 */
import { actorFor, keyOf, makeDriverWithVehicle, makeRider, uniq } from "./test/harness";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { db, lagosDay, stamp } from "./lib/db";
import { PLATFORM, prepare, verifyAccount } from "./ledger/ledger";
import { confirmPayment, previewPayment } from "./domain/pay";
import { decide } from "./domain/approvals";
import { addFinanceEntry, analytics, voidFinanceEntry } from "./domain/analytics";
import { requestDepositIncome } from "./domain/staff";

const admin = () => actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });
const today = () => lagosDay();
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function pay(rider: Awaited<ReturnType<typeof makeRider>>, token: string, passengers = 1) {
  const q = await previewPayment(rider.actor, { qr: token, passengers });
  return confirmPayment(rider.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true });
}

async function unmatchedDeposit(kobo: number) {
  const id = uniq("dep");
  await db.runTransaction(async (tx) => {
    const l = await prepare(tx, {
      txId: `deposit_${id}`,
      type: "deposit.unmatched",
      legs: [
        { account: PLATFORM.bachsFloat, side: "debit", amountKobo: kobo },
        { account: PLATFORM.suspense, side: "credit", amountKobo: kobo },
      ],
    });
    l.commit();
    tx.set(db.doc(`deposits/${id}`), { amountKobo: kobo, status: "unmatched", uid: null, ...stamp() });
  });
  return id;
}

describe("analytics", () => {
  test("rides, money and unique riders come from the real payments, and the books agree", async () => {
    const a = admin();
    const before = await analytics(a, { from: today(), to: today() });
    const first = await makeRider(200_000);
    const second = await makeRider(200_000);
    const driver = await makeDriverWithVehicle(20_000);
    await pay(first, driver.token, 2);
    await pay(second, driver.token);

    const r = await analytics(a, { from: today(), to: today() });
    assert.equal(r.totals.fares - before.totals.fares, 2);
    assert.equal(r.totals.rides - before.totals.rides, 3);
    assert.equal(r.totals.fareKobo - before.totals.fareKobo, 60_000);
    assert.equal(r.usage.ridersInPeriod - before.usage.ridersInPeriod, 2);
    assert.equal(r.checks.fareDifferenceKobo, 0, "ride records and ledger must match");
    assert.equal(r.days.length, 1);
  });

  test("a deposit counts as income only after a second person approves it", async () => {
    const maker = actorFor(uniq("ops"), "ops", { role: "ops", status: "active" });
    const checker = admin();
    const before = await analytics(checker, { from: today(), to: today() });
    const dep = await unmatchedDeposit(20_000_000);
    const { approvalId } = await requestDepositIncome(maker, dep, "ads");

    const waiting = await analytics(checker, { from: today(), to: today() });
    assert.equal(waiting.profit.incomeKobo, before.profit.incomeKobo);

    await decide(checker, approvalId, "approve");
    const after = await analytics(checker, { from: today(), to: today() });
    assert.equal(after.profit.incomeKobo - before.profit.incomeKobo, 20_000_000);
    assert.equal((after.profit.incomeBy.ads ?? 0) - (before.profit.incomeBy.ads ?? 0), 20_000_000);
    assert.equal(after.profit.netKobo - before.profit.netKobo, 20_000_000);
    assert.equal((await db.doc(`deposits/${dep}`).get()).get("status"), "credited");
    assert.equal((await verifyAccount(PLATFORM.revenue)).ok, true);
  });

  test("typed-in costs and income change profit, and a voided line stops counting", async () => {
    const a = admin();
    const before = await analytics(a, { from: today(), to: today() });
    await addFinanceEntry(a, { kind: "income", category: "ads", day: today(), amountKobo: 5_000_000, note: "Paid to the company account" });
    const cost = await addFinanceEntry(a, { kind: "cost", category: "hosting", day: today(), amountKobo: 1_000_000, note: "Domain renewal" });

    const r = await analytics(a, { from: today(), to: today() });
    assert.equal(r.profit.netKobo - before.profit.netKobo, 4_000_000);
    assert.equal((r.profit.runningCosts.hosting ?? 0) - (before.profit.runningCosts.hosting ?? 0), 1_000_000);

    await voidFinanceEntry(a, { id: cost.id, reason: "Entered twice" });
    const v = await analytics(a, { from: today(), to: today() });
    assert.equal(v.profit.netKobo - before.profit.netKobo, 5_000_000);
    assert.equal(v.entries.find((e) => e.id === cost.id)?.voided, true);
  });

  test("a finished day is stored once; today never is", async () => {
    const a = admin();
    const day = shift(today(), -40);
    await db.doc(`analyticsDays/${day}`).delete();
    await analytics(a, { from: day, to: day });
    const stored = await db.doc(`analyticsDays/${day}`).get();
    assert.equal(stored.exists, true);
    await analytics(a, { from: day, to: day });
    assert.deepEqual((await db.doc(`analyticsDays/${day}`).get()).updateTime, stored.updateTime);

    await analytics(a, { from: today(), to: today() });
    assert.equal((await db.doc(`analyticsDays/${today()}`).get()).exists, false);
  });

  test("bad periods are refused", async () => {
    const a = admin();
    await assert.rejects(analytics(a, { from: today(), to: shift(today(), -1) }));
    await assert.rejects(analytics(a, { from: shift(today(), -400), to: today() }));
    await assert.rejects(analytics(a, { from: today(), to: shift(today(), 1) }));
  });
});
