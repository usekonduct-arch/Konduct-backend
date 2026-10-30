/**
 * Analytics: Konduct's profit and usage, for the console's Analytics page.
 *
 * Every figure comes from a record, never an estimate:
 *   money    ledgerTx: what actually moved, in or out of Konduct's own accounts
 *   rides    transactions: each fare, who paid and for how many seats
 *   trips    driverDays: trips, hours and routes, written with each fare
 *   people   users (sign-ups), analyticsDayUsers (who rode or drove that day)
 *   ads      adStatsDays: the capped counts sponsors are shown
 *   other    financeEntries: income paid outside Bachs and running costs, typed in by an admin
 *
 *  analyticsDays/{YYYY-MM-DD}        one finished Lagos day's figures
 *  analyticsDayUsers/{YYYY-MM-DD}    the rider and driver ids active that day (for unique counts)
 *  financeEntries/{id}               a manual income or cost line; voided, never deleted
 *
 * A day is added up once, the first time someone asks after it has finished, so the payment path
 * carries no extra writes and no cron is needed. Today is added up live and never stored. Ledger
 * postings can't change once made, so a stored day stays right; refunds count on the day they
 * happen. Fares are counted from both the ledger and the ride records, and any difference is
 * reported on the page rather than hidden.
 */
import { AggregateField } from "firebase-admin/firestore";
import { z } from "zod";

import { audit } from "../lib/audit";
import { db, lagosDay, stamp, Timestamp, touched } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { type Leg, PLATFORM } from "../ledger/ledger";

/** Raise when a stored day's figures change meaning: older days are added up again. */
const ROLLUP_VERSION = 1;
/** A posting that started just before midnight may land just after; wait before storing the day. */
const SETTLE_MS = 5 * 60_000;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export const INCOME_CATEGORIES = ["ads", "sponsorship", "signups", "airtime", "other"] as const;
export const COST_CATEGORIES = ["hosting", "staff", "marketing", "printing", "transport", "other"] as const;

const dayField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");

const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`) - 3_600_000; // Lagos is UTC+1, all year
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const dayList = (from: string, to: string) => Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));

/** The counted figures of one day. Every field adds up across days. */
const BLANK = {
  fares: 0, // payments for a ride, wallet and cash
  rides: 0, // seats: one payment can cover several people
  cashFares: 0,
  cashRides: 0, // seats sold for cash, which have no rider account
  sponsoredFares: 0,
  trips: 0,
  fareKobo: 0, // what drivers earned
  riderPaidKobo: 0,
  sponsoredKobo: 0,
  cashFareKobo: 0,
  ledgerFareKobo: 0, // the same money, counted from the ledger
  fundCount: 0,
  fundKobo: 0,
  payoutCount: 0,
  payoutKobo: 0,
  refundCount: 0,
  refundKobo: 0,
  sponsorFundedKobo: 0,
  revenueKobo: 0,
  fundingFeesKobo: 0,
  payoutFeesKobo: 0,
  lossesKobo: 0,
  promotionsKobo: 0,
  riderSignups: 0,
  driverSignups: 0,
  adViews: 0,
  adTaps: 0,
};
type Counts = typeof BLANK;
type Day = Counts & {
  day: string;
  activeRiders: number;
  activeDrivers: number;
  incomeBy: Record<string, number>;
  byHour: Record<string, number>;
  routes: Record<string, number>;
};
type DayUsers = { riders: string[]; drivers: string[] };

const signed = (l: Leg, normal: Leg["side"]) => (l.side === normal ? l.amountKobo : -l.amountKobo);
const sum = (legs: Leg[], test: (l: Leg) => boolean) => legs.filter(test).reduce((t, l) => t + l.amountKobo, 0);

/** Adds one ledger transaction to a day. Konduct's accounts count by side, so a reversal subtracts. */
function countMoney(d: Day, tx: { type: string; legs: Leg[]; refs?: Record<string, unknown> | null }) {
  const { type, legs } = tx;
  for (const l of legs) {
    if (l.account === PLATFORM.revenue) {
      const amount = signed(l, "credit");
      const category = String(tx.refs?.category ?? "other");
      d.revenueKobo += amount;
      d.incomeBy[category] = (d.incomeBy[category] ?? 0) + amount;
    } else if (l.account === PLATFORM.bachsFees) {
      if (type.startsWith("payout")) d.payoutFeesKobo += signed(l, "debit");
      else d.fundingFeesKobo += signed(l, "debit");
    } else if (l.account === PLATFORM.losses) d.lossesKobo += signed(l, "debit");
    else if (l.account === PLATFORM.promotions) d.promotionsKobo += signed(l, "debit");
  }
  const toRiders = sum(legs, (l) => l.side === "credit" && l.account.startsWith("rider_"));
  switch (type) {
    case "fare":
    case "fare.cash":
      d.ledgerFareKobo += sum(legs, (l) => l.side === "credit" && l.account.startsWith("driver_"));
      break;
    case "topup":
    case "deposit":
    case "deposit.assign":
      d.fundCount += 1;
      d.fundKobo += toRiders;
      break;
    case "payout.paid":
      d.payoutCount += 1;
      d.payoutKobo += sum(legs, (l) => l.side === "debit" && l.account === PLATFORM.payoutsInProgress);
      break;
    case "refund":
      d.refundCount += 1;
      d.refundKobo += toRiders;
      break;
    case "sponsor.fund":
      d.sponsorFundedKobo += sum(legs, (l) => l.side === "credit" && l.account.startsWith("sponsor_"));
      break;
  }
}

/** Reads a whole day from an ordered query, a page at a time. */
async function allOf(q: FirebaseFirestore.Query) {
  const out: FirebaseFirestore.DocumentData[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    const page = await (last ? q.startAfter(last) : q).limit(1000).get();
    out.push(...page.docs.map((d) => d.data()));
    if (page.size < 1000) return out;
    last = page.docs[page.docs.length - 1];
  }
}

async function addUpDay(day: string): Promise<{ figures: Day; users: DayUsers }> {
  const start = dayStartMs(day);
  const end = start + DAY_MS;
  const [ledger, fares, drivers, signups, ads] = await Promise.all([
    allOf(db.collection("ledgerTx").where("at", ">=", start).where("at", "<", end).orderBy("at").select("type", "legs", "refs")),
    allOf(db.collection("transactions").where("createdAtMs", ">=", start).where("createdAtMs", "<", end).orderBy("createdAtMs")),
    db.collection("driverDays").where("day", "==", day).get(),
    db.collection("users").where("createdAt", ">=", Timestamp.fromMillis(start)).where("createdAt", "<", Timestamp.fromMillis(end)).select("role").get(),
    db.collection("adStatsDays").where("day", "==", day).get(),
  ]);

  const d: Day = { ...BLANK, day, activeRiders: 0, activeDrivers: 0, incomeBy: {}, byHour: {}, routes: {} };
  for (const tx of ledger) countMoney(d, tx as { type: string; legs: Leg[] });

  const riders = new Set<string>();
  const active = new Set<string>();
  for (const t of fares) {
    // Undone fares never happened (stats.ts). A refunded one did: its refund counts on its own day.
    if (t.type !== "fare" || (t.status !== "completed" && t.status !== "refunded")) continue;
    const cash = t.channel === "cash";
    d.fares += 1;
    d.rides += Number(t.passengers ?? 1);
    d.fareKobo += Number(t.totalKobo ?? 0);
    d.riderPaidKobo += Number(t.riderPaidKobo ?? 0);
    d.sponsoredKobo += Number(t.sponsoredKobo ?? 0);
    if (Number(t.sponsoredKobo ?? 0) > 0) d.sponsoredFares += 1;
    if (cash) {
      d.cashFares += 1;
      d.cashRides += Number(t.passengers ?? 1);
      d.cashFareKobo += Number(t.totalKobo ?? 0);
    }
    if (t.payerUid) riders.add(t.payerUid);
    if (t.driverUid) active.add(t.driverUid);
  }
  d.activeRiders = riders.size;
  d.activeDrivers = active.size;

  for (const snap of drivers.docs) {
    const x = snap.data();
    d.trips += Number(x.trips ?? 0);
    for (const [h, v] of Object.entries((x.byHour ?? {}) as Record<string, number>)) d.byHour[h] = (d.byHour[h] ?? 0) + v;
    for (const [r, v] of Object.entries((x.routes ?? {}) as Record<string, number>)) d.routes[r] = (d.routes[r] ?? 0) + v;
  }
  for (const u of signups.docs) {
    if (u.get("role") === "rider") d.riderSignups += 1;
    else if (u.get("role") === "driver") d.driverSignups += 1;
  }
  for (const a of ads.docs) {
    d.adViews += Number(a.get("views") ?? 0);
    d.adTaps += Number(a.get("taps") ?? 0);
  }
  return { figures: d, users: { riders: [...riders], drivers: [...active] } };
}

/** Adds up the days that have no stored figures yet, a few at a time. Today is never stored. */
async function daysFor(days: string[], now: number) {
  const refs = days.map((d) => db.doc(`analyticsDays/${d}`));
  const stored = days.length ? await db.getAll(...refs) : [];
  const out = new Map<string, Day>();
  const live = new Map<string, DayUsers>();
  const missing: string[] = [];
  stored.forEach((s, i) => {
    if (s.exists && s.get("version") === ROLLUP_VERSION) out.set(days[i], s.data() as Day);
    else missing.push(days[i]);
  });
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(
      missing.slice(i, i + 4).map(async (day) => {
        const { figures, users } = await addUpDay(day);
        out.set(day, figures);
        if (dayStartMs(day) + DAY_MS + SETTLE_MS > now) return void live.set(day, users);
        const batch = db.batch();
        batch.set(db.doc(`analyticsDays/${day}`), { ...figures, version: ROLLUP_VERSION, ...stamp() });
        batch.set(db.doc(`analyticsDayUsers/${day}`), { ...users, ...stamp() });
        await batch.commit();
        live.set(day, users);
      }),
    );
  }
  return { byDay: out, live };
}

async function usersFor(days: string[], live: Map<string, DayUsers>) {
  const need = days.filter((d) => !live.has(d));
  const snaps = need.length ? await db.getAll(...need.map((d) => db.doc(`analyticsDayUsers/${d}`))) : [];
  const out = new Map(live);
  snaps.forEach((s, i) => out.set(need[i], { riders: s.get("riders") ?? [], drivers: s.get("drivers") ?? [] }));
  return out;
}

function totalsOf(days: Day[]) {
  const t: Counts & { incomeBy: Record<string, number>; byHour: Record<string, number>; routes: Record<string, number> } = { ...BLANK, incomeBy: {}, byHour: {}, routes: {} };
  for (const d of days) {
    for (const k of Object.keys(BLANK) as (keyof Counts)[]) t[k] += d[k] ?? 0;
    for (const key of ["incomeBy", "byHour", "routes"] as const) {
      for (const [k, v] of Object.entries(d[key] ?? {})) t[key][k] = (t[key][k] ?? 0) + v;
    }
  }
  return t;
}

type Entry = { kind: "income" | "cost"; category: string; amountKobo: number };

/** Profit and loss for a period: money the ledger shows, plus the lines typed in by hand. */
function profitOf(t: ReturnType<typeof totalsOf>, entries: Entry[]) {
  const lines = (kind: Entry["kind"]) => {
    const by: Record<string, number> = {};
    for (const e of entries) if (e.kind === kind) by[e.category] = (by[e.category] ?? 0) + e.amountKobo;
    return by;
  };
  const manualIncome = lines("income");
  const runningCosts = lines("cost");
  const add = (m: Record<string, number>) => Object.values(m).reduce((s, v) => s + v, 0);
  const incomeBy = { ...t.incomeBy };
  for (const [k, v] of Object.entries(manualIncome)) incomeBy[k] = (incomeBy[k] ?? 0) + v;
  const incomeKobo = add(incomeBy);
  const directCostsKobo = t.fundingFeesKobo + t.payoutFeesKobo + t.lossesKobo + t.promotionsKobo;
  const runningCostsKobo = add(runningCosts);
  return {
    incomeKobo,
    incomeBy,
    fundingFeesKobo: t.fundingFeesKobo,
    payoutFeesKobo: t.payoutFeesKobo,
    lossesKobo: t.lossesKobo,
    promotionsKobo: t.promotionsKobo,
    directCostsKobo,
    runningCostsKobo,
    runningCosts,
    netKobo: incomeKobo - directCostsKobo - runningCostsKobo,
  };
}

const uniqueOf = (days: string[], users: Map<string, DayUsers>, who: keyof DayUsers) => new Set(days.flatMap((d) => users.get(d)?.[who] ?? []));

/** Money sitting in Konduct's accounts now, and how much of it actually belongs to Konduct. */
async function moneyNow() {
  const owed = async (kind: string) => {
    const snap = await db.collection("wallets").where("kind", "==", kind).aggregate({ total: AggregateField.sum("balanceKobo") }).get();
    return snap.data().total ?? 0;
  };
  const platform = async (id: string) => ((await db.doc(`wallets/${id}`).get()).get("balanceKobo") as number) ?? 0;
  try {
    const [atBachs, unmatched, payingOut, riders, drivers, sponsors, cashWithAgents] = await Promise.all([
      platform(PLATFORM.bachsFloat),
      platform(PLATFORM.suspense),
      platform(PLATFORM.payoutsInProgress),
      owed("rider"),
      owed("driver"),
      owed("sponsor"),
      owed("agent"),
    ]);
    return { atBachsKobo: atBachs, cashWithAgentsKobo: cashWithAgents, riderWalletsKobo: riders, driverBalancesKobo: drivers, sponsorBudgetsKobo: sponsors, unmatchedKobo: unmatched, payingOutKobo: payingOut, ownKobo: atBachs + cashWithAgents - riders - drivers - sponsors - unmatched - payingOut };
  } catch {
    return null; // the wallets index isn't deployed yet: the rest of the page still works
  }
}

export const AnalyticsInput = z.strictObject({ from: dayField, to: dayField });

export async function analytics(actor: Actor, input: z.infer<typeof AnalyticsInput>) {
  await rateLimit(actor.uid, "analytics", 60, 10 * 60_000);
  const now = Date.now();
  const today = lagosDay(now);
  const { from, to } = input;
  const length = daysBetween(from, to) + 1;
  if (length < 1) fail("invalid-argument", "bad_range", "The start date must come before the end date.");
  if (length > MAX_RANGE_DAYS) fail("invalid-argument", "bad_range", "Pick a period of a year or less.");
  if (to > today) fail("invalid-argument", "bad_range", "The end date can't be in the future.");

  const before = dayList(addDays(from, -length), addDays(from, -1));
  const period = dayList(from, to);
  // The unique-people windows end on the period's last day, so they stay comparable.
  const last28 = dayList(addDays(to, -27), to);
  const { byDay, live } = await daysFor([...new Set([...before, ...period, ...last28])], now);
  const users = await usersFor([...new Set([...period, ...last28])], live);

  const entrySnap = await db.collection("financeEntries").where("day", ">=", before[0]).where("day", "<=", to).orderBy("day", "desc").get();
  const entries = entrySnap.docs.map((d) => ({ id: d.id, ...d.data() })) as (Entry & { id: string; day: string; note: string; byUid: string; voidedAtMs?: number | null })[];
  const counted = entries.filter((e) => !e.voidedAtMs);

  const periodDays = period.map((d) => byDay.get(d)!);
  const totals = totalsOf(periodDays);
  const previous = totalsOf(before.map((d) => byDay.get(d)!));

  const lastWeek = last28.slice(-7);
  const weekBefore = last28.slice(-14, -7);
  const [lastRiders, priorRiders] = [uniqueOf(lastWeek, users, "riders"), uniqueOf(weekBefore, users, "riders")];
  const cameBack = [...priorRiders].filter((u) => lastRiders.has(u)).length;

  const [riderCount, driverCount, recon, money] = await Promise.all([
    db.collection("users").where("role", "==", "rider").count().get(),
    db.collection("users").where("role", "==", "driver").count().get(),
    db.collection("reconReports").orderBy("day", "desc").limit(1).get(),
    moneyNow(),
  ]);
  const r = recon.docs[0];

  return {
    from,
    to,
    generatedAtMs: now,
    days: periodDays.map((d) => ({ ...d, ...dayProfit(d, counted) })),
    totals,
    previous,
    profit: profitOf(totals, counted.filter((e) => e.day >= from)),
    previousProfit: profitOf(previous, counted.filter((e) => e.day < from)),
    usage: {
      ridersInPeriod: uniqueOf(period, users, "riders").size,
      driversInPeriod: uniqueOf(period, users, "drivers").size,
      riders7d: lastRiders.size,
      riders28d: uniqueOf(last28, users, "riders").size,
      riderAccounts: riderCount.data().count,
      driverAccounts: driverCount.data().count,
      retention: priorRiders.size ? { base: priorRiders.size, back: cameBack } : null,
    },
    money,
    checks: {
      fareDifferenceKobo: totals.fareKobo - totals.ledgerFareKobo,
      lastRecon: r ? { day: r.get("day"), ok: r.get("ok") === true, varianceKobo: r.get("varianceKobo") ?? null } : null,
    },
    entries: entries.filter((e) => e.day >= from).map((e) => ({ id: e.id, day: e.day, kind: e.kind, category: e.category, amountKobo: e.amountKobo, note: e.note, byUid: e.byUid, voided: Boolean(e.voidedAtMs) })),
  };
}

function dayProfit(d: Day, entries: (Entry & { day: string })[]) {
  const own = entries.filter((e) => e.day === d.day);
  const add = (kind: Entry["kind"]) => own.filter((e) => e.kind === kind).reduce((s, e) => s + e.amountKobo, 0);
  const incomeKobo = d.revenueKobo + add("income");
  const costKobo = d.fundingFeesKobo + d.payoutFeesKobo + d.lossesKobo + d.promotionsKobo + add("cost");
  return { incomeKobo, costKobo };
}

/* ---------------------------------------------------- lines typed in by hand */

export const AddFinanceEntry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("income"), category: z.enum(INCOME_CATEGORIES), day: dayField, amountKobo: z.number().int().positive().max(1_000_000_000), note: z.string().trim().min(3, "Say what this is.").max(160) }),
  z.strictObject({ kind: z.literal("cost"), category: z.enum(COST_CATEGORIES), day: dayField, amountKobo: z.number().int().positive().max(1_000_000_000), note: z.string().trim().min(3, "Say what this is.").max(160) }),
]);

/** Income paid outside Bachs, or a running cost. No money moves: it only feeds the profit figures. */
export async function addFinanceEntry(actor: Actor, input: z.infer<typeof AddFinanceEntry>) {
  if (input.day > lagosDay()) fail("invalid-argument", "future_day", "The date can't be in the future.");
  const ref = db.collection("financeEntries").doc();
  await db.runTransaction(async (tx) => {
    tx.create(ref, { ...input, byUid: actor.uid, voidedAtMs: null, ...stamp() });
    audit({ actor: actor.uid, action: `finance.${input.kind}`, target: ref.path, after: input, ip: actor.ip }, tx);
  });
  return { id: ref.id };
}

export const VoidFinanceEntry = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/), reason: z.string().trim().min(3, "Say why.").max(160) });

/** Mistakes are voided, not deleted, so the audit trail keeps what the figures once said. */
export async function voidFinanceEntry(actor: Actor, input: z.infer<typeof VoidFinanceEntry>) {
  const ref = db.doc(`financeEntries/${input.id}`);
  await db.runTransaction(async (tx) => {
    const e = await tx.get(ref);
    if (!e.exists) fail("not-found", "no_entry", "No such line.");
    if (e.get("voidedAtMs")) fail("failed-precondition", "already_void", "This line was already removed.");
    tx.update(ref, { voidedAtMs: Date.now(), voidedBy: actor.uid, voidReason: input.reason, ...touched() });
    audit({ actor: actor.uid, action: "finance.void", target: ref.path, after: { reason: input.reason }, ip: actor.ip }, tx);
  });
  return { ok: true };
}
