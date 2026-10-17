/**
 * Sponsors, sponsored rides and ad measurement, against the Firestore + Auth emulators. The money
 * rules: a sponsor's budget only comes from real deposits, a sponsored seat moves exactly one fare
 * from the sponsor to the driver, budgets and caps hold under parallel scans, and a rider can't be
 * refunded money a sponsor paid. The measurement rules: only real, live, visible-to-you ads count,
 * retries never double-count, and one person can't inflate the numbers.
 */
import { actorFor, balance, keyOf, makeDriverWithVehicle, makeRider, uniq } from "./test/harness";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { db, lagosDay, stamp } from "./lib/db";
import { isHttpsError } from "./lib/errors";
import { driverAccount, PLATFORM, prepare, riderAccount, sponsorAccount, verifyAccount } from "./ledger/ledger";
import { confirmPayment, previewPayment } from "./domain/pay";
import { decide } from "./domain/approvals";
import { openDispute, resolveDispute, reviewDispute } from "./domain/disputes";
import { receiptProof } from "./domain/receipts";
import { requestSponsorFunding, setWrappedSponsor, upsertRideCampaign, upsertSponsor } from "./domain/sponsors";
import { upsertAd } from "./domain/messaging";
import { CAPS, trackAds } from "./domain/adstats";

const admin = () => actorFor(uniq("adm"), "admin", { role: "admin", status: "active" });

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (isHttpsError(e)) return (e.details as { reason: string }).reason;
    throw e;
  }
};

/** A bank transfer nobody could match: it sits in suspense, as the webhook leaves it. */
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

/** A sponsor with a funded budget (deposit → approval by a second admin). */
async function fundedSponsor(budgetKobo: number) {
  const maker = admin();
  const { id } = await upsertSponsor(maker, { name: "MTN Nigeria", logoUrl: "https://example.com/mtn.png", website: "", contactName: "", contactEmail: "", contactPhone: "", notes: "", active: true });
  if (budgetKobo > 0) {
    const dep = await unmatchedDeposit(budgetKobo);
    const { approvalId } = await requestSponsorFunding(maker, { depositId: dep, sponsorId: id });
    await decide(admin(), approvalId, "approve");
  }
  return id;
}

async function campaign(sponsorId: string, over: Partial<{ perRiderPerDay: number; perDriverPerDay: number; maxSpendKobo: number; routeIds: string[]; startsAtMs: number; endsAtMs: number }> = {}) {
  const now = Date.now();
  const { id } = await upsertRideCampaign(admin(), {
    sponsorId,
    title: "Free rides to lectures",
    message: "On MTN, all week",
    startsAtMs: now - 60_000,
    endsAtMs: now + 86_400_000,
    routeIds: [],
    perRiderPerDay: 2,
    perDriverPerDay: 100,
    maxSpendKobo: 0,
    active: true,
    ...over,
  });
  return id;
}

// Live campaigns apply to every scan, so each test switches its own off when done.
const end = (id: string, sponsorId: string) =>
  upsertRideCampaign(admin(), { sponsorId, title: "Ended", message: "", startsAtMs: 1, endsAtMs: 2, routeIds: [], perRiderPerDay: 1, perDriverPerDay: 1, maxSpendKobo: 0, active: false, id });

const pay = async (r: Awaited<ReturnType<typeof makeRider>>, token: string, passengers = 1) => {
  const q = await previewPayment(r.actor, { qr: token, passengers });
  return { q, out: await confirmPayment(r.actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true }) };
};

describe("sponsored rides", () => {
  test("a sponsor's budget comes only from a real deposit, approved by a second person", async () => {
    const sponsorId = await fundedSponsor(0);
    const dep = await unmatchedDeposit(500_000);
    const suspenseBefore = await balance(PLATFORM.suspense);
    const { approvalId } = await requestSponsorFunding(admin(), { depositId: dep, sponsorId });
    assert.equal(await balance(sponsorAccount(sponsorId)), 0); // nothing until approved
    await decide(admin(), approvalId, "approve");
    assert.equal(await balance(sponsorAccount(sponsorId)), 500_000);
    assert.equal(await balance(PLATFORM.suspense), suspenseBefore - 500_000);
    assert.equal((await db.doc(`deposits/${dep}`).get()).get("status"), "credited");
    assert.equal((await db.doc(`sponsors/${sponsorId}`).get()).get("fundedKobo"), 500_000);
    assert.equal(await reason(requestSponsorFunding(admin(), { depositId: dep, sponsorId })), "not_unmatched"); // can't fund twice
    assert.ok((await verifyAccount(sponsorAccount(sponsorId))).ok);
  });

  test("the sponsor pays the rider's seat, the driver gets the full fare, the books balance", async () => {
    const sponsorId = await fundedSponsor(100_000);
    const cid = await campaign(sponsorId);
    try {
      const d = await makeDriverWithVehicle(20_000);
      const r = await makeRider(0); // an empty wallet still rides free
      const { q, out } = await pay(r, d.token);
      assert.equal(q.riderPaysKobo, 0);
      assert.equal(q.insufficient, false);
      assert.equal(q.sponsored?.name, "MTN Nigeria");
      assert.equal(q.sponsored?.logoUrl, "https://example.com/mtn.png");
      assert.equal(out.riderPaidKobo, 0);
      assert.equal(out.sponsorName, "MTN Nigeria");
      assert.equal(out.balanceKobo, 0);
      assert.equal(await balance(riderAccount(r.uid)), 0);
      assert.equal(await balance(driverAccount(d.uid)), 20_000);
      assert.equal(await balance(sponsorAccount(sponsorId)), 80_000);
      const t = await db.doc(`transactions/${out.txId}`).get();
      assert.equal(t.get("riderPaidKobo"), 0);
      assert.equal(t.get("sponsoredKobo"), 20_000);
      assert.equal(t.get("sponsor").campaignId, cid);
      const c = await db.doc(`rideCampaigns/${cid}`).get();
      assert.equal(c.get("rides"), 1);
      assert.equal(c.get("spentKobo"), 20_000);
      assert.equal(c.get("uniqueRiders"), 1);
      const day = await db.doc(`campaignDays/${cid}_${lagosDay()}`).get();
      assert.equal(day.get("rides"), 1);
      assert.equal(day.get("riders"), 1);
      for (const a of [sponsorAccount(sponsorId), driverAccount(d.uid)]) assert.ok((await verifyAccount(a)).ok, a);
      // The rider can still prove the ride: their receipt rests on the sponsor's leg.
      const proof = await receiptProof(r.actor, { kind: "fare", id: out.txId });
      assert.equal(proof.verified, true);
    } finally {
      await end(cid, sponsorId);
    }
  });

  test("on a group scan the sponsor pays one seat and the rider pays the friends", async () => {
    const sponsorId = await fundedSponsor(100_000);
    const cid = await campaign(sponsorId);
    try {
      const d = await makeDriverWithVehicle(20_000);
      const r = await makeRider(100_000);
      const { q, out } = await pay(r, d.token, 3);
      assert.equal(q.totalKobo, 60_000);
      assert.equal(q.riderPaysKobo, 40_000);
      assert.equal(out.riderPaidKobo, 40_000);
      assert.equal(await balance(riderAccount(r.uid)), 60_000);
      assert.equal(await balance(driverAccount(d.uid)), 60_000);
      assert.equal(await balance(sponsorAccount(sponsorId)), 80_000);
      assert.ok((await verifyAccount(riderAccount(r.uid))).ok);
    } finally {
      await end(cid, sponsorId);
    }
  });

  test("the per-rider daily cap holds: the next ride that day is the rider's own", async () => {
    const sponsorId = await fundedSponsor(200_000);
    const cid = await campaign(sponsorId, { perRiderPerDay: 1 });
    try {
      const d = await makeDriverWithVehicle(20_000);
      const r = await makeRider(100_000);
      assert.equal((await pay(r, d.token)).out.riderPaidKobo, 0);
      const second = await pay(r, d.token);
      assert.equal(second.q.sponsored, null);
      assert.equal(second.out.riderPaidKobo, 20_000);
      assert.equal(await balance(sponsorAccount(sponsorId)), 180_000);
    } finally {
      await end(cid, sponsorId);
    }
  });

  test("the per-driver daily cap stops a driver draining a budget with many riders", async () => {
    const sponsorId = await fundedSponsor(500_000);
    const cid = await campaign(sponsorId, { perDriverPerDay: 2 });
    try {
      const d = await makeDriverWithVehicle(20_000);
      const paid = [];
      for (let i = 0; i < 3; i++) paid.push((await pay(await makeRider(100_000), d.token)).out.riderPaidKobo);
      assert.deepEqual(paid, [0, 0, 20_000]);
      assert.equal(await balance(sponsorAccount(sponsorId)), 460_000);
    } finally {
      await end(cid, sponsorId);
    }
  });

  test("parallel scans can't spend past the budget: the late ones are told the offer ended", async () => {
    const sponsorId = await fundedSponsor(40_000); // two rides
    const cid = await campaign(sponsorId);
    try {
      const d = await makeDriverWithVehicle(20_000);
      const riders = await Promise.all(Array.from({ length: 6 }, () => makeRider(100_000)));
      const quotes = await Promise.all(riders.map((r) => previewPayment(r.actor, { qr: d.token, passengers: 1 })));
      assert.ok(quotes.every((q) => q.sponsored)); // all quoted while money was left
      const results = await Promise.allSettled(quotes.map((q, i) => confirmPayment(riders[i].actor, { quoteId: q.quoteId, idempotencyKey: keyOf(), repeatConfirmed: true })));
      const ok = results.filter((x) => x.status === "fulfilled");
      const ended = results.filter((x) => x.status === "rejected" && isHttpsError(x.reason) && (x.reason.details as { reason: string }).reason === "offer_ended");
      assert.equal(ok.length, 2);
      assert.equal(ended.length, 4);
      assert.equal(await balance(sponsorAccount(sponsorId)), 0);
      assert.equal(await balance(driverAccount(d.uid)), 40_000);
      assert.equal((await db.doc(`rideCampaigns/${cid}`).get()).get("spentKobo"), 40_000);
      assert.ok((await verifyAccount(sponsorAccount(sponsorId))).ok);
    } finally {
      await end(cid, sponsorId);
    }
  });

  test("a campaign's spend cap holds even with budget left over", async () => {
    const sponsorId = await fundedSponsor(500_000);
    const cid = await campaign(sponsorId, { maxSpendKobo: 20_000 });
    try {
      const d = await makeDriverWithVehicle(20_000);
      assert.equal((await pay(await makeRider(100_000), d.token)).out.riderPaidKobo, 0);
      assert.equal((await pay(await makeRider(100_000), d.token)).out.riderPaidKobo, 20_000);
    } finally {
      await end(cid, sponsorId);
    }
  });

  test("an offer only covers its routes and its dates", async () => {
    const sponsorId = await fundedSponsor(100_000);
    const elsewhere = await campaign(sponsorId, { routeIds: ["no_such_route_x"] });
    const later = await campaign(sponsorId, { startsAtMs: Date.now() + 3_600_000, endsAtMs: Date.now() + 7_200_000 });
    try {
      const d = await makeDriverWithVehicle(20_000);
      const { q } = await pay(await makeRider(100_000), d.token);
      assert.equal(q.sponsored, null);
    } finally {
      await end(elsewhere, sponsorId);
      await end(later, sponsorId);
    }
  });

  test("a rider is refunded only what they paid, never the sponsor's money", async () => {
    const sponsorId = await fundedSponsor(100_000);
    const cid = await campaign(sponsorId);
    try {
      const d = await makeDriverWithVehicle(20_000);
      const free = await makeRider(0);
      const { out: freeRide } = await pay(free, d.token);
      assert.equal(await reason(openDispute(free.actor, { txId: freeRide.txId, reason: "wrong_vehicle", note: "" })), "nothing_paid");

      const group = await makeRider(100_000);
      const { out } = await pay(group, d.token, 2); // paid 20,000 of 40,000
      await openDispute(group.actor, { txId: out.txId, reason: "wrong_amount", note: "" });
      const support = actorFor(uniq("sup"), "support", { role: "support", status: "active" });
      await reviewDispute(support, out.txId);
      assert.equal(await reason(resolveDispute(support, { disputeId: out.txId, outcome: "refund", amountKobo: 40_000, note: "checked" })), "too_much");
      await resolveDispute(support, { disputeId: out.txId, outcome: "refund", note: "checked" });
      assert.equal(await balance(riderAccount(group.uid)), 100_000);
    } finally {
      await end(cid, sponsorId);
    }
  });
});

describe("ad measurement", () => {
  const ad = async (audience: "all" | "rider" | "driver" = "all") =>
    (
      await upsertAd(admin(), {
        placement: "carousel",
        audience,
        title: "Data bundles",
        body: "",
        imageUrl: "https://example.com/ad.jpg",
        link: "",
        buttons: [],
        active: true,
        startsAtMs: null,
        endsAtMs: null,
        order: 1,
        sponsorId: "",
      })
    ).id;
  const ev = (id: string, k: "view" | "tap" | "share", at = Date.now()) => ({ t: "ad" as const, id, k, at });
  const stats = async (id: string) => (await db.doc(`adStats/ad_${id}`).get()).data() ?? {};

  test("views, taps and reach add up; a retried batch is never counted twice", async () => {
    const id = await ad();
    const a = await makeRider();
    const b = await makeRider();
    const batch = uniq("batch").padEnd(16, "x");
    assert.equal((await trackAds(a.actor, { batchId: batch, events: [ev(id, "view"), ev(id, "view"), ev(id, "tap")] })).counted, 3);
    assert.equal((await trackAds(a.actor, { batchId: batch, events: [ev(id, "view"), ev(id, "view"), ev(id, "tap")] })).duplicate, true);
    await trackAds(b.actor, { batchId: uniq("batch").padEnd(16, "x"), events: [ev(id, "view")] });
    const s = await stats(id);
    assert.equal(s.views, 3);
    assert.equal(s.taps, 1);
    assert.equal(s.reach, 2);
    const day = (await db.doc(`adStatsDays/ad_${id}_${lagosDay()}`).get()).data()!;
    assert.equal(day.uniques, 2);
  });

  test("one person can't inflate an ad past the daily caps", async () => {
    const id = await ad();
    const a = await makeRider();
    for (let i = 0; i < 3; i++) await trackAds(a.actor, { batchId: uniq("batch").padEnd(16, "x"), events: Array.from({ length: 20 }, () => ev(id, "view")) });
    assert.equal((await stats(id)).views, CAPS.view);
    assert.equal((await stats(id)).reach, 1);
  });

  test("events for ads you can't see, unknown ads, and stale events count for nothing", async () => {
    const forDrivers = await ad("driver");
    const r = await makeRider();
    const out = await trackAds(r.actor, {
      batchId: uniq("batch").padEnd(16, "x"),
      events: [ev(forDrivers, "view"), ev("noSuchAd123", "view"), ev(await ad(), "view", Date.now() - 4 * 86_400_000)],
    });
    assert.equal(out.counted, 0);
    assert.equal((await stats(forDrivers)).views, undefined);
  });

  test("a Wrapped sponsorship counts views and shares", async () => {
    const sponsorId = await fundedSponsor(0);
    const month = `${2000 + Math.floor(Math.random() * 900)}-07`;
    await setWrappedSponsor(admin(), { month, sponsorId, message: "", link: "", audience: "all", active: true });
    const r = await makeRider();
    await trackAds(r.actor, { batchId: uniq("batch").padEnd(16, "x"), events: [{ t: "wrapped", id: month, k: "view", at: Date.now() }, { t: "wrapped", id: month, k: "share", at: Date.now() }] });
    const s = (await db.doc(`adStats/wrapped_${month}`).get()).data()!;
    assert.equal(s.views, 1);
    assert.equal(s.shares, 1);
    assert.equal(s.sponsorId, sponsorId);
  });
});
