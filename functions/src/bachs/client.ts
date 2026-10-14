/**
 * Thin, defensive Bachs API client (https://docs.bachs.io).
 * - Host is chosen by key prefix: sk_sandbox_ -> sandbox, sk_live_ -> production.
 * - Every write carries an Idempotency-Key derived from our own record id.
 * - A timeout or 5xx on a write is "outcome unknown", never "failed": callers reconcile by GET.
 * - Request/response bodies are never logged (they can hold names and account numbers).
 */
import { logger } from "firebase-functions";

import { BACHS_API_KEY } from "../config";

export class BachsError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
    public requestId: string | null,
    /** True when the request may have taken effect (timeout, network error, 5xx). */
    public uncertain: boolean,
  ) {
    super(`Bachs ${status} ${code}`);
  }
}

type Opts = { idempotencyKey?: string; accountId?: string; timeoutMs?: number };

function base(key: string) {
  if (key.startsWith("sk_live_")) return "https://api.bachs.io";
  if (key.startsWith("sk_sandbox_")) return "https://sandbox-api.bachs.io";
  throw new Error("BACHS_API_KEY must start with sk_live_ or sk_sandbox_");
}

export const bachsIsLive = () => BACHS_API_KEY.value().startsWith("sk_live_");

export async function bachs<T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  const key = BACHS_API_KEY.value();
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (opts.accountId) headers["X-Account-Id"] = opts.accountId;

  let res: Response;
  try {
    res = await fetch(`${base(key)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      redirect: "error",
    });
  } catch (e) {
    logger.warn("bachs network error", { method, path: path.split("?")[0], err: (e as Error).name });
    throw new BachsError(0, "NETWORK", "network error", null, method !== "GET");
  }

  const requestId = res.headers.get("x-request-id");
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const code = (json.error_code as string) ?? `HTTP_${res.status}`;
    logger.warn("bachs error", { method, path: path.split("?")[0], status: res.status, code, requestId });
    throw new BachsError(res.status, code, String(json.detail ?? ""), requestId, res.status >= 500 || res.status === 409 && code === "IDEMPOTENCY_IN_PROGRESS");
  }
  return json as T;
}

/* ------------------------------------------------------------ typed calls we use */

export type CheckoutSession = {
  checkout_id: string;
  checkout_url?: string;
  status: string; // open | completed | expired
  payment_status?: string; // paid | unpaid | no_payment_required
  amount?: string;
  currency?: string;
  reference?: string | null;
  metadata?: Record<string, string>;
  charge?: { id: string; amount: string; currency: string; status: string; settlement_amount?: string } | null;
};

export const createCheckout = (body: Record<string, unknown>, idempotencyKey: string) =>
  bachs<CheckoutSession>("POST", "/v1/checkout-sessions", body, { idempotencyKey });

export const getCheckout = (checkoutId: string) => bachs<CheckoutSession>("GET", `/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`);

export type ConnectedAccount = {
  id: string;
  capabilities?: Record<string, { status: string }>;
  requirements?: { currently_due?: string[]; errors?: { field: string; reason: string }[] };
};

export const createRecipientAccount = (body: Record<string, unknown>, idempotencyKey: string) =>
  bachs<ConnectedAccount>("POST", "/v1/accounts", body, { idempotencyKey });

export const updateAccount = (accountId: string, body: Record<string, unknown>) =>
  bachs<ConnectedAccount>("POST", `/v1/accounts/${encodeURIComponent(accountId)}`, body);

export const getAccount = (accountId: string) => bachs<ConnectedAccount>("GET", `/v1/accounts/${encodeURIComponent(accountId)}`);

export type PayoutDestination = { id: string; is_usable: boolean; status: string; account_name?: string; account_number?: string; bank_code?: string };

export const listDestinations = (accountId: string) =>
  bachs<{ data?: PayoutDestination[] } & Record<string, unknown>>("GET", "/v1/payouts/destinations", undefined, { accountId });

export const getDestination = (accountId: string, destinationId: string) =>
  bachs<PayoutDestination>("GET", `/v1/payouts/destinations/${encodeURIComponent(destinationId)}`, undefined, { accountId });

export type Transfer = { id: string; status: string; amount: string; currency: string };

export const createTransfer = (body: Record<string, unknown>, idempotencyKey: string) => bachs<Transfer>("POST", "/v1/transfers", body, { idempotencyKey });

export type Payout = { id: string; status: string; amount: string; fee?: string; total_debited?: string; reference?: string; failure_reason?: string | null };

export const createPayout = (accountId: string, body: Record<string, unknown>, idempotencyKey: string) =>
  bachs<Payout>("POST", "/v1/payouts", body, { idempotencyKey, accountId });

export const getPayout = (accountId: string, payoutId: string) =>
  bachs<Payout>("GET", `/v1/payouts/${encodeURIComponent(payoutId)}`, undefined, { accountId });

export type Balances = { balances?: { currency: string; available_balance: string; pending_balance?: string }[] } & Record<string, unknown>;

export const getBalances = () => bachs<Balances>("GET", "/v1/balances");

export const getBanks = (country: string) =>
  bachs<{ country?: string; banks?: { code?: string; name?: string }[] }>("GET", `/v1/reference/banks?country=${encodeURIComponent(country)}`);
