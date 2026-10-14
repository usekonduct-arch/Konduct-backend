# Konduct backend

Firebase Cloud Functions (2nd gen, Node 22, TypeScript) + Firestore, with **Bachs** for card/bank
funding, the virtual account and driver payouts. Implements the SRS P0 money paths: identity, wallet,
ledger, scan-to-pay, pay-for-friends, offline codes, disputes, driver payouts, staff operations,
maker-checker, kill switches and reconciliation.

```
cd functions
npm install
npm test               # unit tests (no emulator)
npm run test:emulator  # attack + integrity tests against Firestore/Auth emulators (needs JDK 11+)
```

On this PC the emulator needs Android Studio's JDK:
`JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"` with its `bin` first on `PATH`.

## How money moves

| Flow | What happens |
| --- | --- |
| **Top-up** | `createTopUp` opens a Bachs hosted checkout (NGN card / NGN bank transfer) with our reference `tu_…`. The rider pays on Bachs's page; card data never touches us. A signed `collection.succeeded` / `checkout.completed` webhook triggers `settleTopUp`, which **re-reads the checkout from the Bachs API** and checks status, reference and currency before crediting once. |
| **Bank deposit** | Riders can also transfer to Konduct's one Bachs virtual account with their funding code (`KDxxxxxx`) in the narration. Matched by code, then by a sender account already linked to them. Anything else goes to `platform_suspense` and the `deposits` review queue; staff assign it with a second approval. |
| **Pay** | `payPreview` validates the signed sticker, vehicle, driver and route, prices from the fare table and stores a single-use 2-minute quote. `payConfirm` (idempotency key) runs one transaction: limits, PIN above ₦500, balance, ledger, receipt, a trip per passenger, the driver's live alert. |
| **Undo / refund** | `payUndo` within 60s; disputes refund by reversal. Refunds over ₦5,000 need a second person. If the driver was already paid out, Konduct covers it (`platform_losses`). |
| **Payout** | Each driver is a Bachs Connect *recipient* account with their own verified bank destination. Daily at 21:30 (or on request): reserve in the ledger, transfer to the driver's Bachs account, payout to their bank, settle on `payout.paid`, or pull back and return the reservation on failure. |

All amounts are integer kobo. The ledger (`wallets`, `ledgerTx`, `ledgerEntries`) is double-entry,
append-only and hash-chained per account; posting the same transaction id twice is a no-op.

## Security model

| Threat | Control | Tested in |
| --- | --- | --- |
| Client edits its balance, writes a fake payment, or makes itself admin | Firestore rules deny every client write to money, identity and roles. Only the server writes, via callables. | `rules.emu.ts` |
| Reading someone else's wallet, receipt or payout by changing an id (BOLA) | Rules match `ownerUid` / `payerUid`; callables check ownership and give the same answer for "not yours" and "doesn't exist" | `rules.emu.ts`, `money.emu.ts` |
| Double debit on retry or double-tap | Idempotency key per payment returns the original result; quotes are single-use; ledger tx ids are unique | `money.emu.ts` |
| Race: parallel scans against one balance | Balance changes only inside Firestore transactions with the ledger entries; a balance can't go below zero | `money.emu.ts` (8 parallel payments, room for 5) |
| Client sends its own price | Amounts are never accepted from clients. The quote is priced from the route's fare table and versioned. | `money.emu.ts` |
| Forged, swapped or old QR sticker | HMAC-signed `K1.<vehicle>.<version>.<sig>`; re-issuing bumps the version; the preview shows driver, plate and route, and warns about recently changed stickers | `core.test.ts`, `money.emu.ts` |
| Forged or replayed Bachs webhook | HMAC-SHA256 over timestamp + raw body, 5-minute window, constant-time compare, origin must be our account or one of our drivers' accounts, dedupe by event id | `core.test.ts`, `money.emu.ts` |
| Genuine-looking webhook with wrong details | Every top-up is re-confirmed by a Bachs API read (reference, status, currency) before credit | `money.emu.ts` |
| Stolen phone, password or PIN guessing | scrypt-hashed PINs (server only), 5 tries then a 30-minute lock and a security flag, burst rate limit; self-lock (`lockMyAccount`) | `money.emu.ts` |
| Suspended account keeps using an old token | Every call reads live profile status; suspension also revokes refresh tokens | `money.emu.ts` |
| Changing payout bank to steal earnings | Needs a fresh password sign-in (< 5 min) + PIN, bank name must match the verified driver, second-person approval, 24h hold before first payout, push alert | `money.emu.ts` |
| Someone signs up with a driver's email (emails aren't verified yet) | The email alone unlocks nothing: claiming a driver record needs the agent's one-time 8-character code, stored only as an HMAC, 5 wrong tries lock it | `money.emu.ts` |
| Insider abuse | Maker-checker for refunds > ₦5k, manual adjustments, deposit assignment, KYC tier, role grants and resuming payouts; the approver must be a different person with the right role; append-only audit log | `money.emu.ts` |
| Ledger tampering in the database | Per-account hash chain; nightly `verifyAccount` re-derives every touched wallet | `money.emu.ts` |
| Books drift from the bank | Nightly reconciliation against the Bachs balance halts automatic payouts and raises an alert | `money.emu.ts` |
| Brute force / abuse | Firestore-backed rate limits per person and action; velocity hold on payments; App Check on every callable | partly (App Check needs a device) |
| Leaking internals | Strict schemas reject unknown fields; unexpected errors return a generic message; no PII or Bachs bodies in logs | |

## Before the first deploy

**Firebase (project console)**
1. **Blaze plan**: Functions, phone auth and Secret Manager need it.
2. **Firestore** in production mode. Its location is permanent; match `REGION` in `src/config.ts` and the app's `AppConfig.functionsRegion`.
3. **Authentication**:
   - Click **Get started**, then turn on **Email/Password**: riders, drivers and staff all use it.
     Email verification is deliberately off for now; drivers are protected by the agent's onboarding code instead.
   - Upgrade to **Identity Platform** and enable **multi-factor auth**. Staff endpoints refuse any sign-in without a second factor.
4. **App Check**:
   - Register both Android apps with Play Integrity, then set `ENFORCE_APP_CHECK=true` in `functions/.env.<project>`.
   - In the console, also enforce App Check for Firestore.
5. Separate **dev / staging / prod** projects (SEC-OPS-01). Use the Bachs sandbox key outside prod.

**Secrets** (`firebase functions:secrets:set NAME --project <id>`). Use long random values and never change the first three:

| Secret | What it is |
| --- | --- |
| `IDENTITY_KEY` | keyed hash for driver onboarding codes; changing it voids every unused code |
| `QR_SIGNING_KEY` | signs stickers; changing it voids every printed sticker |
| `OFFLINE_CODE_KEY` | derives the 6-character offline payment codes |
| `BACHS_API_KEY` | `sk_sandbox_…` or `sk_live_…`, scopes below |
| `BACHS_WEBHOOK_SECRETS` | endpoint signing secret; during a rotation, both secrets comma-separated |

**Params** (`functions/.env.<project>`): `BACHS_ACCOUNT_ID=acct_…` (required; webhooks are refused
without it), `TOPUP_RETURN_URL`, `DRIVER_CONTACT_EMAIL`, `ENFORCE_APP_CHECK`, `MIN_INSTANCES_PAY=1` in production.

**Bachs dashboard**
- **API key scopes** (least privilege):
  - `payments:read`, `payments:write`, `payouts:read`, `payouts:write`
  - `transfers:write`, `connected_accounts:read`, `connected_accounts:write`
  - `virtual_accounts:read`, `virtual_accounts:write`
- **Capabilities.** Request `connect` (to create driver accounts) and `virtual_accounts`. Both need business verification and the representative's BVN.
- **Webhook endpoint:**
  - URL: `https://<region>-<project>.cloudfunctions.net/bachsWebhook`
  - `event_source: all`, so driver payout events arrive too.
  - Events: `collection.succeeded`, `checkout.completed`, `checkout.expired`, `payout.paid`, `payout.failed`, `account.updated`, `capability.updated`, `dispute.created`, `dispute.updated`.

**Deploy**
```
firebase deploy --only firestore:rules,firestore:indexes,functions --project <id>
```
The indexes file also turns on TTL clean-up for `rateLimits`, `payQuotes` and `idempotency`.

**First staff member**
1. Create an email/password user and verify the email.
2. Run `npm run bootstrap-admin -- --email you@…`.
3. Enrol MFA.

Every later role is granted through `staffGrantRole` plus a second admin's approval.

## How people sign in

- **Riders**: email + password, then name + student ID (`registerRider`). The student ID is unique per campus.
- **Drivers**: an agent onboards them at the park with `staffInviteDriver` (email, name, plate, route, checks), which
  returns a one-time **8-character onboarding code**. The driver creates an account with that email in the
  driver app and enters the code (`claimDriverAccount`). Lost or locked code: `staffResetDriverCode`.
- **Staff**: email + password + a second factor (MFA), with a verified email.
- Email verification for riders and drivers is planned; until then no email is trusted on its own.

## Known gaps (not yet built, or blocked on a decision)

- **Per-rider virtual accounts (FR-WAL-01).** Bachs issues one number per account, so riders share Konduct's number and are matched by funding code or known sender. The alternative is a Bachs Connect account per rider, each needing BVN, ID and manual review. Decide with Bachs.
- **Bank deposits aren't re-confirmed by API.** Deposits are trusted from the signed webhook and checked by nightly reconciliation. Bachs documents no lookup by `charge_id` for deposits, so ask Bachs for one.
- **Email verification** for riders and drivers (planned next). **SMS (FR-NTF-02, FR-DRV-05).** Nothing sends SMS yet: no provider is chosen. Security notices go out as push notifications today.
- **Deferred SRS items:**
  - Device binding (FR-AUTH-07, P1)
  - Instant cash-out (P1)
  - Agent cash payouts (FR-DRV-07)
  - Seat status (Phase 3)
  - Fuel (Phase 4)
  - BigQuery export, CSV/PDF exports
- **Not done yet:**
  - A penetration test before launch (SEC-OPS-06)
  - Backups with PITR and a restore drill (SEC-OPS-03)
  - Alerting and on-call (SEC-OPS-04)
