// ─────────────────────────────────────────
//  FAKE PAYSTACK — every request to api.paystack.co in the suite lands here
//  (installed by tests/setup.ts, like the fake Cloudinary), so no test ever
//  reaches Paystack, test mode included, and a test that forgets to mock it
//  still can't.
//
//  It answers the calls this app makes, in Paystack's envelope
//  ({ status, message, data }): initialize, verify, list transactions,
//  refunds and settlements, fetch/create/disable a subscription, its manage
//  link, fetch a customer, and the bank list. State lives in memory, reset
//  before every test.
//
//  A test drives it with:
//   pay(reference, …)       — the payer completes a checkout: success, a
//                              transaction id, paid_at, a customer. Returns
//                              the webhook `data` Paystack would send.
//   fail(reference)          — the attempt fails.
//   addSubscription(…)       — a subscription Paystack holds.
//   failNext(match, how)     — the next matching call times out, loses the
//                              network, or answers with a status and body.
//                              'timeoutAfterApplying': Paystack acts on it,
//                              then the answer is lost (an unclear outcome
//                              that really happened).
//   subaccounts              — the subaccounts Paystack holds (POST
//                              /subaccount, listed and fetched). The full
//                              account number is kept here only because
//                              Paystack keeps it; the app never stores it.
//   calls / callsTo(path)    — what was asked of it.
//
//  A test file that mocks paystack.client.js itself (vi.mock) keeps doing
//  so; this sits underneath, at fetch.
// ─────────────────────────────────────────

import crypto from 'crypto';

export interface FakeTransaction {
  id: number;
  reference: string;
  amount: number;
  currency: string;
  status: string;
  email: string;
  plan: string | null;
  paid_at: string | null;
  created_at: string;
  customer: { customer_code: string; email: string };
  metadata?: unknown;
  // A split payment (ticket sales): as initialize was asked.
  subaccount?: string | null;
  transaction_charge?: number | null;
  bearer?: string | null;
  channels?: string[] | null;
  // Paystack's fee, as it reports it on the payment: by default each part
  // rounded up (2.9% + R1, then 15% VAT), as Paystack charges a local card.
  fees?: number | null;
}

export interface FakeSubscription {
  subscription_code: string;
  email_token: string;
  status: string;
  next_payment_date: string | null;
  plan_code: string;
  plan_amount: number;
  customer_code: string;
  email: string;
  authorization_code: string;
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Failure = 'timeout' | 'timeoutAfterApplying' | 'network' | { status: number; body?: unknown };

export interface FakeSubaccount {
  subaccount_code: string;
  business_name: string;
  settlement_bank: string;
  account_number: string;
  description: string | null;
  percentage_charge: number;
  active: boolean;
  created_at: string;
}

const API = 'https://api.paystack.co';

// Ids (and the SUB_/tok_/T references made from them) start at a random
// point per process: the test database outlives a run, and a run that
// stopped before its cleanup leaves tenants holding SUB_ codes and ledger
// rows holding transaction ids that a fixed start would hand out again
// (Tenant_paystackSubscriptionCode_key; a "redelivery" that isn't one).
let nextId = 5_000_000 + crypto.randomInt(0, 2_000_000_000);
const newId = (): number => ++nextId;

export const fakePaystack = {
  transactions: new Map<string, FakeTransaction>(),
  subscriptions: new Map<string, FakeSubscription>(),
  subaccounts: new Map<string, FakeSubaccount>(),
  // The bank list GET /bank answers.
  banks: [{ name: 'Fake Bank', code: '000' }] as { name: string; code: string }[],
  refunds: [] as Record<string, unknown>[],
  settlements: [] as Record<string, unknown>[],
  calls: [] as FakeCall[],
  failures: [] as { match: (call: FakeCall) => boolean; how: Failure; times: number }[],
  // Plan code -> amount, for subscriptions created through POST /subscription.
  planAmounts: new Map<string, number>(),

  reset(): void {
    this.transactions.clear();
    this.subscriptions.clear();
    this.subaccounts.clear();
    this.banks = [{ name: 'Fake Bank', code: '000' }];
    this.refunds = [];
    this.settlements = [];
    this.calls = [];
    this.failures = [];
    this.planAmounts.clear();
  },

  callsTo(method: string, pathPrefix: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix));
  },

  failNext(match: string | ((call: FakeCall) => boolean), how: Failure, times = 1): void {
    const matcher = typeof match === 'string' ? (call: FakeCall) => `${call.method} ${call.path}`.startsWith(match) : match;
    this.failures.push({ match: matcher, how, times });
  },

  customerCodeFor(email: string): string {
    // A hash of the whole address: the first bytes alone ("billing-…" for
    // every payments tenant) gave two tenants the same customer once in a
    // few hundred, and a charge went to whichever findByCustomerCode found.
    return `CUS_${crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 20)}`;
  },

  // The payer completes the checkout for `reference`. Returns the webhook
  // data Paystack would send for charge.success.
  pay(
    reference: string,
    overrides: Partial<{ amount: number; currency: string; paidAt: string; fees: number; subaccount: string | null; transactionCharge: number }> = {}
  ): Record<string, unknown> {
    const tx = this.transactions.get(reference);
    if (!tx) throw new Error(`fake Paystack: no transaction ${reference}`);
    tx.status = 'success';
    tx.paid_at = overrides.paidAt ?? new Date().toISOString();
    if (overrides.amount !== undefined) tx.amount = overrides.amount;
    if (overrides.currency !== undefined) tx.currency = overrides.currency;
    if (overrides.fees !== undefined) tx.fees = overrides.fees;
    if (overrides.subaccount !== undefined) tx.subaccount = overrides.subaccount;
    if (overrides.transactionCharge !== undefined) tx.transaction_charge = overrides.transactionCharge;
    if (tx.plan) {
      // A plan checkout creates the subscription, as Paystack does.
      this.addSubscription({ email: tx.email, plan_code: tx.plan, plan_amount: tx.amount });
    }
    return this.webhookDataFor(reference);
  },

  fail(reference: string): Record<string, unknown> {
    const tx = this.transactions.get(reference);
    if (!tx) throw new Error(`fake Paystack: no transaction ${reference}`);
    tx.status = 'failed';
    return this.webhookDataFor(reference);
  },

  webhookDataFor(reference: string): Record<string, unknown> {
    const tx = this.transactions.get(reference)!;
    return {
      id: tx.id,
      reference: tx.reference,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      paid_at: tx.paid_at,
      created_at: tx.created_at,
      channel: 'card',
      gateway_response: tx.status === 'success' ? 'Approved' : 'Declined',
      customer: tx.customer,
      ...(tx.plan && { plan: { plan_code: tx.plan, amount: tx.amount } }),
      authorization: { authorization_code: 'AUTH_fake', card_type: 'visa', last4: '4081', exp_month: '12', exp_year: '2030' },
      ...(tx.metadata !== undefined && { metadata: tx.metadata }),
      ...(tx.status === 'success' && { fees: tx.fees ?? fakePaystackFee(tx.amount) }),
      // A split: the subaccount, and how the payment was divided (the
      // subaccount gets amount − transaction_charge with bearer "account").
      ...(tx.subaccount && {
        subaccount: { subaccount_code: tx.subaccount },
        fees_split: {
          paystack: tx.fees ?? fakePaystackFee(tx.amount),
          integration: (tx.transaction_charge ?? 0) - (tx.fees ?? fakePaystackFee(tx.amount)),
          subaccount: tx.amount - (tx.transaction_charge ?? 0),
          params: { bearer: tx.bearer ?? 'account', transaction_charge: String(tx.transaction_charge ?? 0), percentage_charge: '0' },
        },
      }),
    };
  },

  // A transaction Paystack holds that this app didn't start (a renewal).
  addTransaction(input: { reference?: string; amount: number; email: string; plan?: string | null; status?: string; paidAt?: string; currency?: string }): FakeTransaction {
    const reference = input.reference ?? `T${newId()}`;
    const tx: FakeTransaction = {
      id: newId(),
      reference,
      amount: input.amount,
      currency: input.currency ?? 'ZAR',
      status: input.status ?? 'success',
      email: input.email,
      plan: input.plan ?? null,
      paid_at: input.status && input.status !== 'success' ? null : input.paidAt ?? new Date().toISOString(),
      created_at: input.paidAt ?? new Date().toISOString(),
      customer: { customer_code: this.customerCodeFor(input.email), email: input.email },
    };
    this.transactions.set(reference, tx);
    return tx;
  },

  addSubscription(input: Partial<FakeSubscription> & { email: string; plan_code: string; plan_amount: number }): FakeSubscription {
    const sub: FakeSubscription = {
      subscription_code: input.subscription_code ?? `SUB_${newId()}`,
      email_token: input.email_token ?? `tok_${newId()}`,
      status: input.status ?? 'active',
      next_payment_date: input.next_payment_date === undefined ? new Date(Date.now() + 30 * 24 * 3600_000).toISOString() : input.next_payment_date,
      plan_code: input.plan_code,
      plan_amount: input.plan_amount,
      customer_code: input.customer_code ?? this.customerCodeFor(input.email),
      email: input.email,
      authorization_code: input.authorization_code ?? 'AUTH_fake',
    };
    this.subscriptions.set(sub.subscription_code, sub);
    return sub;
  },

  // The subscription.create webhook data Paystack sends for `sub`.
  subscriptionCreateData(sub: FakeSubscription): Record<string, unknown> {
    return {
      id: newId(),
      subscription_code: sub.subscription_code,
      email_token: sub.email_token,
      status: sub.status,
      next_payment_date: sub.next_payment_date,
      customer: { customer_code: sub.customer_code, email: sub.email },
      plan: { plan_code: sub.plan_code, amount: sub.plan_amount, currency: 'ZAR' },
      authorization: { authorization_code: sub.authorization_code, card_type: 'visa', last4: '4081', exp_month: '12', exp_year: '2030' },
    };
  },

  subscriptionFor(email: string): FakeSubscription[] {
    return [...this.subscriptions.values()].filter((s) => s.email.toLowerCase() === email.toLowerCase());
  },
};

// Paystack's local card fee as it charges it: each part rounded up.
export const fakePaystackFee = (amount: number): number => {
  const percent = Math.ceil((amount * 290) / 10_000);
  return percent + 100 + Math.ceil(((percent + 100) * 15) / 100);
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => json(200, { status: true, message: 'ok', data, ...(meta !== undefined && { meta }) });
const notFound = (message: string) => json(404, { status: false, message });
const bad = (message: string) => json(400, { status: false, message });

const subscriptionView = (s: FakeSubscription) => ({
  id: 1,
  subscription_code: s.subscription_code,
  email_token: s.email_token,
  status: s.status,
  next_payment_date: s.next_payment_date,
  customer: { customer_code: s.customer_code, email: s.email },
  plan: { plan_code: s.plan_code, amount: s.plan_amount },
  authorization: { authorization_code: s.authorization_code, last4: '4081', card_type: 'visa', exp_month: '12', exp_year: '2030' },
});

const inWindow = (iso: string | null, query: Record<string, string>): boolean => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  const from = query['from'] ? new Date(query['from']).getTime() : -Infinity;
  const to = query['to'] ? new Date(query['to']).getTime() : Infinity;
  return t >= from && t < to;
};

const handle = (call: FakeCall): Response => {
  const { method, path, query, body } = call;
  const f = fakePaystack;

  if (method === 'POST' && path === '/transaction/initialize') {
    const reference = String(body?.['reference'] ?? `T${newId()}`);
    if (f.transactions.has(reference)) return bad('Duplicate Transaction Reference');
    const email = String(body?.['email'] ?? '');
    f.transactions.set(reference, {
      id: newId(),
      reference,
      amount: Number(body?.['amount']),
      currency: String(body?.['currency'] ?? 'ZAR'),
      status: 'abandoned',
      email,
      plan: typeof body?.['plan'] === 'string' ? (body['plan'] as string) : null,
      paid_at: null,
      created_at: new Date().toISOString(),
      customer: { customer_code: f.customerCodeFor(email), email },
      metadata: body?.['metadata'],
      subaccount: typeof body?.['subaccount'] === 'string' ? (body['subaccount'] as string) : null,
      transaction_charge: typeof body?.['transaction_charge'] === 'number' ? (body['transaction_charge'] as number) : null,
      bearer: typeof body?.['bearer'] === 'string' ? (body['bearer'] as string) : null,
      channels: Array.isArray(body?.['channels']) ? (body['channels'] as string[]) : null,
    });
    return ok({ authorization_url: `https://checkout.paystack.test/${reference}`, access_code: `ac_${reference}`, reference });
  }

  const verify = path.match(/^\/transaction\/verify\/(.+)$/);
  if (method === 'GET' && verify) {
    const reference = decodeURIComponent(verify[1]!);
    if (!f.transactions.has(reference)) return bad('Transaction reference not found');
    return ok(f.webhookDataFor(reference));
  }

  if (method === 'GET' && path === '/transaction') {
    const rows = [...f.transactions.values()].filter((t) => inWindow(t.paid_at ?? t.created_at, query));
    return ok(rows.map((t) => f.webhookDataFor(t.reference)), { total: rows.length, page: 1, pageCount: 1 });
  }

  if (method === 'GET' && path === '/refund') return ok(f.refunds, { pageCount: 1 });
  if (method === 'GET' && path === '/settlement') return ok(f.settlements, { pageCount: 1 });
  if (method === 'GET' && path === '/bank') return ok(f.banks.map((b) => ({ ...b, country: 'South Africa', currency: 'ZAR' })));

  if (method === 'POST' && path === '/subaccount') {
    const bank = f.banks.find((b) => b.code === body?.['settlement_bank']);
    if (!bank) return bad('Invalid settlement bank');
    const accountNumber = String(body?.['account_number'] ?? '');
    if (!/^\d{6,16}$/.test(accountNumber)) return bad('Account number is invalid');
    const sub: FakeSubaccount = {
      subaccount_code: `ACCT_${newId()}`,
      business_name: String(body?.['business_name'] ?? ''),
      settlement_bank: bank.name,
      account_number: accountNumber,
      description: typeof body?.['description'] === 'string' ? (body['description'] as string) : null,
      percentage_charge: Number(body?.['percentage_charge'] ?? 0),
      active: true,
      created_at: new Date().toISOString(),
    };
    f.subaccounts.set(sub.subaccount_code, sub);
    return ok(sub);
  }

  if (method === 'GET' && path === '/subaccount') {
    // Newest first, as Paystack lists them.
    const rows = [...f.subaccounts.values()].reverse();
    const perPage = Number(query['perPage'] ?? 50);
    const page = Number(query['page'] ?? 1);
    const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
    return ok(rows.slice((page - 1) * perPage, page * perPage), { total: rows.length, page, pageCount, perPage });
  }

  const subaccount = path.match(/^\/subaccount\/([^/]+)$/);
  if (subaccount) {
    const found = f.subaccounts.get(decodeURIComponent(subaccount[1]!));
    if (!found) return notFound('Subaccount not found');
    if (method === 'GET') return ok(found);
    if (method === 'PUT') {
      Object.assign(found, {
        ...(body?.['business_name'] !== undefined && { business_name: String(body['business_name']) }),
        ...(body?.['account_number'] !== undefined && { account_number: String(body['account_number']) }),
        ...(body?.['active'] !== undefined && { active: Boolean(body['active']) }),
      });
      return ok(found);
    }
  }

  if (method === 'POST' && path === '/subscription') {
    const customer = String(body?.['customer'] ?? '');
    const plan = String(body?.['plan'] ?? '');
    const existing = [...f.subscriptions.values()].find((s) => s.customer_code === customer);
    const email = existing?.email ?? `${customer}@fake.test`;
    const sub = f.addSubscription({ email, plan_code: plan, plan_amount: f.planAmounts.get(plan) ?? 0, customer_code: customer });
    return ok({ subscription_code: sub.subscription_code, email_token: sub.email_token, status: sub.status, next_payment_date: sub.next_payment_date, customer: 1, plan: 2, authorization: 3 });
  }

  if (method === 'POST' && path === '/subscription/disable') {
    const sub = f.subscriptions.get(String(body?.['code'] ?? ''));
    if (!sub || sub.email_token !== body?.['token']) return notFound('Subscription not found');
    sub.status = 'cancelled';
    return ok({});
  }

  const manage = path.match(/^\/subscription\/([^/]+)\/manage\/link$/);
  if (method === 'GET' && manage) return ok({ link: `https://paystack.test/manage/${manage[1]}` });

  const sub = path.match(/^\/subscription\/([^/]+)$/);
  if (method === 'GET' && sub) {
    const found = f.subscriptions.get(decodeURIComponent(sub[1]!));
    return found ? ok(subscriptionView(found)) : notFound('Subscription not found');
  }

  const customer = path.match(/^\/customer\/([^/]+)$/);
  if (method === 'GET' && customer) {
    const code = decodeURIComponent(customer[1]!);
    const subs = [...f.subscriptions.values()].filter((s) => s.customer_code === code);
    return ok({ customer_code: code, email: subs[0]?.email ?? `${code}@fake.test`, subscriptions: subs.map(subscriptionView) });
  }

  return notFound(`fake Paystack has no ${method} ${path}`);
};

export const installFakePaystack = (): void => {
  const realFetch = globalThis.fetch;
  if ((realFetch as { __fakePaystack?: boolean }).__fakePaystack) return;
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== API) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const call: FakeCall = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null,
    };
    fakePaystack.calls.push(call);
    const failure = fakePaystack.failures.find((f) => f.times > 0 && f.match(call));
    if (failure) {
      failure.times--;
      if (failure.how === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (failure.how === 'network') throw new TypeError('fetch failed');
      if (failure.how === 'timeoutAfterApplying') {
        handle(call);
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return json(failure.how.status, failure.how.body ?? { status: false, message: `fake ${failure.how.status}` });
    }
    return handle(call);
  }) as typeof fetch & { __fakePaystack?: boolean };
  wrapped.__fakePaystack = true;
  globalThis.fetch = wrapped;
};
