/**
 * Receipt verification. Every money movement is a hash-chained ledger entry (ledger.ts), so a
 * receipt can be vouched for by re-checking its entry.
 *
 *  receiptProof   the owner asks for proof of one of their fares, top-ups or payouts. Returns the
 *                 entry's details and a verification code: "<ledger txId>.<first 20 hex of its hash>".
 *  receipt page   GET <base>/receipt/<code>, public. Anyone holding the code (the QR on the
 *                 receipt) sees that it is genuine: type, amount, time, reference, status. Never
 *                 names, accounts or balances. 80 bits of hash make codes unguessable.
 */
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { z } from "zod";

import { db } from "../lib/db";
import { fail } from "../lib/errors";
import { type Actor, rateLimit } from "../lib/guards";
import { naira } from "../lib/money";
import { publicBase } from "../lib/public";
import { driverAccount, riderAccount, sponsorAccount, verifyEntry } from "../ledger/ledger";

export const ReceiptProofInput = z.strictObject({
  kind: z.enum(["fare", "topup", "payout"]),
  id: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/),
});

const HASH_CHARS = 20;

const ledgerTxId = (kind: "fare" | "topup" | "payout", id: string) => (kind === "fare" ? id : `${kind}_${id}`);

export async function receiptProof(actor: Actor, input: z.infer<typeof ReceiptProofInput>) {
  await rateLimit(actor.uid, "receipt", 30, 60_000);
  const account = actor.role === "driver" ? driverAccount(actor.uid) : riderAccount(actor.uid);
  const txId = ledgerTxId(input.kind, input.id);
  // Only this person's own leg: someone else's transaction simply isn't found.
  let q = await db.collection("ledgerEntries").where("txId", "==", txId).where("account", "==", account).limit(1).get();
  // A ride a sponsor paid in full has no leg on the rider's wallet: its proof is the sponsor's leg,
  // shown only to the rider who took that ride.
  if (q.empty && input.kind === "fare" && actor.role === "rider") {
    const t = await db.doc(`transactions/${txId}`).get();
    const sponsorId = (t.get("sponsor") as { id?: string } | null | undefined)?.id;
    if (t.get("payerUid") === actor.uid && sponsorId) {
      q = await db.collection("ledgerEntries").where("txId", "==", txId).where("account", "==", sponsorAccount(sponsorId)).limit(1).get();
    }
  }
  if (q.empty) return { verified: false, posted: false };
  const e = q.docs[0].data();
  const check = await verifyEntry(e);
  if (!check.ok) fail("data-loss", "receipt_unverified", "We couldn't verify this receipt. Our team has been told.", { problem: check.problem });
  const head = await db.doc(`ledgerTx/${txId}`).get();
  const code = `${txId}.${(e.hash as string).slice(0, HASH_CHARS)}`;
  return {
    verified: true,
    posted: true,
    code,
    verifyUrl: `${publicBase()}/receipt/${code}`,
    hash: e.hash as string,
    seq: e.seq as number,
    side: e.side as string,
    amountKobo: e.amountKobo as number,
    balanceAfterKobo: e.balanceAfterKobo as number,
    postedAtMs: e.at as number,
    reversed: Boolean(head.get("reversedBy")),
  };
}

const TYPE_LABEL: Record<string, string> = {
  fare: "Ride fare",
  "fare.cash": "Ride fare, paid in cash at the park",
  topup: "Wallet top-up",
  deposit: "Bank deposit",
  "payout.reserve": "Withdrawal to bank",
};

/** Looks a code up and says whether it is a genuine, unaltered Konduct ledger record. */
export async function lookUpReceipt(code: string) {
  const m = /^([A-Za-z0-9_-]{6,90})\.([0-9a-f]{20})$/.exec(code);
  if (!m) return null;
  const [, txId, prefix] = m;
  const [head, entries] = await Promise.all([db.doc(`ledgerTx/${txId}`).get(), db.collection("ledgerEntries").where("txId", "==", txId).limit(8).get()]);
  const e = entries.docs.map((d) => d.data()).find((x) => (x.hash as string).startsWith(prefix));
  if (!head.exists || !e) return null;
  const check = await verifyEntry(e);
  const refs = (head.get("refs") ?? {}) as Record<string, unknown>;
  let status = head.get("reversedBy") ? "Reversed" : "Completed";
  if (head.get("type") === "payout.reserve" && typeof refs.payoutId === "string") {
    const p = (await db.doc(`payouts/${refs.payoutId}`).get()).get("status") as string | undefined;
    status = p === "paid" ? "Paid to bank" : p === "returned" ? "Returned to wallet" : "On its way";
  }
  return {
    genuine: check.ok,
    type: String(e.account).startsWith("sponsor_") ? "Sponsored ride fare" : (TYPE_LABEL[head.get("type") as string] ?? "Konduct payment"),
    amountKobo: e.amountKobo as number,
    at: new Date(e.at as number),
    reference: typeof refs.reference === "string" ? refs.reference : txId.slice(-10).toUpperCase(),
    status,
    fingerprint: (e.hash as string).slice(0, 32),
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** GET /receipt/<code>: a small self-contained page, also what the apps open in their web view. */
export async function handleReceiptPage(req: Request, res: Response) {
  if (req.method !== "GET") return void res.status(405).send("method not allowed");
  const code = decodeURIComponent((req.path ?? "").replace(/^\/(receipt\/)?/, "")).slice(0, 140);
  let r: Awaited<ReturnType<typeof lookUpReceipt>> = null;
  try {
    r = await lookUpReceipt(code);
  } catch {
    r = null;
  }
  const when = r?.at.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
  const ok = r?.genuine === true;
  const body = r
    ? `<div class="seal ${ok ? "ok" : "bad"}">${ok ? "&#10003;" : "!"}</div>
       <h1>${ok ? "Genuine Konduct receipt" : "This record failed its check"}</h1>
       <p class="sub">${ok ? "It matches Konduct's tamper-proof ledger." : "Please contact Konduct support with this page."}</p>
       <dl>
         <dt>Type</dt><dd>${esc(r.type)}</dd>
         <dt>Amount</dt><dd class="amt">${esc(naira(r.amountKobo))}</dd>
         <dt>When</dt><dd>${esc(when ?? "")}</dd>
         <dt>Reference</dt><dd class="mono">${esc(r.reference)}</dd>
         <dt>Status</dt><dd>${esc(r.status)}</dd>
         <dt>Fingerprint</dt><dd class="mono small">${esc(r.fingerprint)}</dd>
       </dl>`
    : `<div class="seal bad">?</div><h1>Receipt not found</h1><p class="sub">This code doesn't match any Konduct record. Check that the whole link or QR was scanned.</p>`;
  res.set("Cache-Control", "no-store");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  res.set("X-Robots-Tag", "noindex");
  res.status(r ? 200 : 404).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Konduct receipt check</title><style>
:root{--ink:#11151C;--paper:#FFFDF6;--yellow:#FFC93C;--go:#1FB46A;--coral:#F2545B;--mute:#6B7280}
*{box-sizing:border-box}body{margin:0;background:var(--yellow);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{background:var(--paper);border-radius:28px;max-width:420px;width:100%;padding:32px 24px;box-shadow:0 24px 60px -20px rgba(17,21,28,.35);text-align:center}
.brand{font-weight:800;letter-spacing:.14em;font-size:12px;color:var(--mute);margin-bottom:20px}
.seal{width:76px;height:76px;border-radius:50%;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:800;color:#fff}
.ok{background:var(--go)}.bad{background:var(--coral)}h1{font-size:22px;margin:0 0 6px}.sub{color:var(--mute);margin:0 0 22px;font-size:14px}
dl{display:grid;grid-template-columns:auto 1fr;gap:10px 16px;text-align:left;border-top:2px dashed #E5E1D5;padding-top:18px;margin:0}
dt{color:var(--mute);font-size:14px}dd{margin:0;text-align:right;font-weight:700;overflow-wrap:anywhere}.amt{font-size:20px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}.small{font-size:12px;font-weight:500}
</style></head><body><main><div class="brand">KONDUCT · RECEIPT CHECK</div>${body}</main></body></html>`);
}
