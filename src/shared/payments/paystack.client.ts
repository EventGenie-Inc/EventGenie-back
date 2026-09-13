import crypto from 'crypto';

// ─────────────────────────────────────────
//  PAYSTACK CLIENT
//
//  Knows Paystack and nothing else — no Event, Tenant, Guest or tier
//  concepts. Same separation as sms.engine.ts / email.engine.ts, built
//  that way deliberately and reused unmodified ever since. Every
//  function here speaks Paystack's vocabulary (subaccounts, channels,
//  bearer) and integer cents — never Decimal, never a float rand
//  amount. Callers convert at the money.util.ts boundary before they
//  ever reach this file.
//
//  PAYSTACK_SECRET_KEY is validated at MODULE LOAD, not lazily at first
//  call: a payment module that silently no-ops because a key was never
//  set is worse than one that refuses to start. Any router that
//  transitively imports this file (payment-account, payment-webhook)
//  will therefore fail app.ts's startup import chain immediately if the
//  key is missing, before the server ever binds a port.
// ─────────────────────────────────────────

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) {
  throw new Error(
    'PAYSTACK_SECRET_KEY is not defined in .env — the payments module cannot start without it.'
  );
}

// Re-assigned to a const of a narrowed type so every call site below
// gets `string`, not `string | undefined`, without a non-null
// assertion at each use.
const SECRET_KEY: string = PAYSTACK_SECRET_KEY;

// ─────────────────────────────────────────
//  ERROR
//
//  Carries Paystack's own `message` field — the whole point of a
//  dedicated error type is that a caller can surface "Invalid account
//  number" or "Could not resolve account name" to the tenant admin
//  instead of a generic "something went wrong". See paystack.com/docs's
//  transaction/subaccount error shapes: a non-2xx response, or a 2xx
//  with `status: false`, both carry a human-readable `message`.
// ─────────────────────────────────────────
export class PaystackApiError extends Error {
  paystackMessage: string;
  httpStatus: number;

  constructor(paystackMessage: string, httpStatus: number) {
    super(`Paystack request failed (${httpStatus}): ${paystackMessage}`);
    this.name = 'PaystackApiError';
    this.paystackMessage = paystackMessage;
    this.httpStatus = httpStatus;
  }
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

const paystackRequest = async <T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: Record<string, unknown>
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (networkError) {
    const reason = networkError instanceof Error ? networkError.message : 'Unknown network error';
    throw new PaystackApiError(`Could not reach Paystack: ${reason}`, 0);
  }

  let json: PaystackEnvelope<T>;
  try {
    json = (await response.json()) as PaystackEnvelope<T>;
  } catch {
    throw new PaystackApiError('Paystack returned a non-JSON response', response.status);
  }

  if (!response.ok || !json.status) {
    throw new PaystackApiError(json.message || 'Unknown Paystack error', response.status);
  }

  return json.data;
};

// ─────────────────────────────────────────
//  TRANSACTIONS
// ─────────────────────────────────────────

interface PaystackTransactionInitializeData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface InitializeTransactionParams {
  email: string;
  // Integer cents — Paystack's `amount` field is already denominated in
  // the smallest unit of the currency (cents for ZAR), so this is passed
  // straight through with no conversion inside this file.
  amountCents: number;
  currency?: string;
  reference?: string;
  callbackUrl?: string;
  // Which payment methods the customer may use — e.g. ['card'] for a
  // subscription charge, ['card', 'eft'] for a guest ticket purchase.
  // This client has no opinion on which; the caller (a feature not
  // built in this batch) decides based on who's paying.
  channels?: string[];
  // Split-at-source destination — the organiser's subaccount code. Left
  // entirely optional/generic here; how a specific commission amount
  // gets translated into subaccount/transactionChargeCents/bearer is a
  // ticketing decision, not this client's.
  subaccount?: string;
  transactionChargeCents?: number;
  bearer?: 'account' | 'subaccount';
  // A Paystack Plan code — passed by the Subscription Billing batch's
  // subscribe flow to turn a one-off checkout into the first charge of
  // a recurring subscription (Paystack creates the Subscription object
  // automatically on success and reports it via a subscription.create
  // webhook). This client has no opinion on what a plan is; it just
  // forwards the code.
  plan?: string;
  metadata?: Record<string, unknown>;
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export const initializeTransaction = async (
  params: InitializeTransactionParams
): Promise<InitializeTransactionResult> => {
  const data = await paystackRequest<PaystackTransactionInitializeData>('POST', '/transaction/initialize', {
    email: params.email,
    amount: params.amountCents,
    currency: params.currency ?? 'ZAR',
    ...(params.reference !== undefined && { reference: params.reference }),
    ...(params.callbackUrl !== undefined && { callback_url: params.callbackUrl }),
    ...(params.channels !== undefined && { channels: params.channels }),
    ...(params.subaccount !== undefined && { subaccount: params.subaccount }),
    ...(params.transactionChargeCents !== undefined && { transaction_charge: params.transactionChargeCents }),
    ...(params.bearer !== undefined && { bearer: params.bearer }),
    ...(params.plan !== undefined && { plan: params.plan }),
    ...(params.metadata !== undefined && { metadata: params.metadata }),
  });

  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference,
  };
};

interface PaystackTransactionVerifyData {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  gateway_response: string;
  paid_at: string | null;
  channel: string | null;
  customer?: { email?: string };
  authorization?: { authorization_code?: string };
  [key: string]: unknown;
}

export interface VerifyTransactionResult {
  reference: string;
  status: string;
  amountCents: number;
  currency: string;
  gatewayResponse: string;
  paidAt: string | null;
  channel: string | null;
  customerEmail: string | null;
  authorizationCode: string | null;
  // The full, verbatim Paystack payload — callers store this straight
  // into PaymentLedgerEntry.payload rather than reconstructing it later.
  raw: PaystackTransactionVerifyData;
}

export const verifyTransaction = async (reference: string): Promise<VerifyTransactionResult> => {
  const data = await paystackRequest<PaystackTransactionVerifyData>(
    'GET',
    `/transaction/verify/${encodeURIComponent(reference)}`
  );

  return {
    reference: data.reference,
    status: data.status,
    amountCents: data.amount,
    currency: data.currency,
    gatewayResponse: data.gateway_response,
    paidAt: data.paid_at ?? null,
    channel: data.channel ?? null,
    customerEmail: data.customer?.email ?? null,
    authorizationCode: data.authorization?.authorization_code ?? null,
    raw: data,
  };
};

// ─────────────────────────────────────────
//  SUBACCOUNTS
// ─────────────────────────────────────────

interface PaystackSubaccountData {
  subaccount_code: string;
  business_name: string;
  settlement_bank: string;
  account_number: string;
  active: boolean;
  percentage_charge: number;
  [key: string]: unknown;
}

export interface CreateSubaccountParams {
  businessName: string;
  // Bank code, not a human-readable bank name — from listBanks() below.
  settlementBank: string;
  accountNumber: string;
  // The subaccount's OWN default split — set to 0 so the subaccount
  // receives 100% of whatever is routed to it by default. Per-ticket
  // splitting (routing exactly the ticket price to the subaccount and
  // the commission + Paystack fee to the platform) is done per
  // transaction via transactionChargeCents/bearer on
  // initializeTransaction, not via this default — that computation
  // belongs to ticketing, not this client.
  percentageCharge?: number;
  description?: string;
  primaryContactEmail?: string;
  primaryContactName?: string;
  primaryContactPhone?: string;
}

export interface SubaccountResult {
  subaccountCode: string;
  businessName: string;
  settlementBank: string;
  accountNumber: string;
  active: boolean;
  raw: PaystackSubaccountData;
}

const toSubaccountResult = (data: PaystackSubaccountData): SubaccountResult => ({
  subaccountCode: data.subaccount_code,
  businessName: data.business_name,
  settlementBank: data.settlement_bank,
  accountNumber: data.account_number,
  active: data.active,
  raw: data,
});

export const createSubaccount = async (params: CreateSubaccountParams): Promise<SubaccountResult> => {
  const data = await paystackRequest<PaystackSubaccountData>('POST', '/subaccount', {
    business_name: params.businessName,
    settlement_bank: params.settlementBank,
    account_number: params.accountNumber,
    percentage_charge: params.percentageCharge ?? 0,
    ...(params.description !== undefined && { description: params.description }),
    ...(params.primaryContactEmail !== undefined && { primary_contact_email: params.primaryContactEmail }),
    ...(params.primaryContactName !== undefined && { primary_contact_name: params.primaryContactName }),
    ...(params.primaryContactPhone !== undefined && { primary_contact_phone: params.primaryContactPhone }),
  });

  return toSubaccountResult(data);
};

export const updateSubaccount = async (
  subaccountCode: string,
  params: Partial<CreateSubaccountParams> & { active?: boolean }
): Promise<SubaccountResult> => {
  const data = await paystackRequest<PaystackSubaccountData>('PUT', `/subaccount/${encodeURIComponent(subaccountCode)}`, {
    ...(params.businessName !== undefined && { business_name: params.businessName }),
    ...(params.settlementBank !== undefined && { settlement_bank: params.settlementBank }),
    ...(params.accountNumber !== undefined && { account_number: params.accountNumber }),
    ...(params.percentageCharge !== undefined && { percentage_charge: params.percentageCharge }),
    ...(params.description !== undefined && { description: params.description }),
    ...(params.primaryContactEmail !== undefined && { primary_contact_email: params.primaryContactEmail }),
    ...(params.primaryContactName !== undefined && { primary_contact_name: params.primaryContactName }),
    ...(params.primaryContactPhone !== undefined && { primary_contact_phone: params.primaryContactPhone }),
    ...(params.active !== undefined && { active: params.active }),
  });

  return toSubaccountResult(data);
};

// Used only to fill the masked-detail cache for subaccounts that existed
// before EventGenie stored a last-four fragment. Normal status reads stay
// local after that one refresh; this is not a Paystack dependency on every
// organiser page load.
export const getSubaccount = async (subaccountCode: string): Promise<SubaccountResult> => {
  const data = await paystackRequest<PaystackSubaccountData>(
    'GET',
    `/subaccount/${encodeURIComponent(subaccountCode)}`
  );
  return toSubaccountResult(data);
};

// ─────────────────────────────────────────
//  BANKS
//
//  Needed so a tenant admin's onboarding form can offer a bank picker —
//  without a bank CODE (not a name) there is no valid `settlementBank`
//  to submit at all. Not explicitly requested by name in the task
//  prompt, but without it the submit/update endpoints below are
//  unusable in practice; flagged in the report rather than assumed.
// ─────────────────────────────────────────

interface PaystackBankData {
  name: string;
  code: string;
  [key: string]: unknown;
}

export interface PaystackBank {
  name: string;
  code: string;
}

export const listBanks = async (params?: { country?: string; currency?: string }): Promise<PaystackBank[]> => {
  const query = new URLSearchParams({
    country: params?.country ?? 'south africa',
    currency: params?.currency ?? 'ZAR',
  });

  const data = await paystackRequest<PaystackBankData[]>('GET', `/bank?${query.toString()}`);
  return data.map((bank) => ({ name: bank.name, code: bank.code }));
};

// ─────────────────────────────────────────
//  WEBHOOK SIGNATURE VERIFICATION
//
//  Paystack sends an HMAC-SHA512 of the RAW request body, hex-encoded,
//  in the x-paystack-signature header — keyed with the SECRET key.
//  There is no separate webhook secret to go looking for. Must be
//  computed over the exact bytes Paystack sent, not a re-serialised
//  JSON.stringify(req.body) (key order/whitespace could differ and
//  silently break every signature) — see raw-body.middleware.ts for how
//  the raw buffer is preserved through Express's JSON parser.
// ─────────────────────────────────────────

export const verifyWebhookSignature = (
  rawBody: Buffer | string,
  signatureHeader: string | string[] | undefined
): boolean => {
  if (!signatureHeader || Array.isArray(signatureHeader)) return false;

  const expected = crypto.createHmac('sha512', SECRET_KEY).update(rawBody).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, so that has to be checked first — a length mismatch is
  // itself a definitive "not equal", not an error condition.
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
};

// ─────────────────────────────────────────
//  PLANS
//
//  A Plan is Paystack's own recurring-billing template (amount,
//  interval, currency) — created once per environment (see
//  prisma/create-subscription-plans.ts, run manually) and referenced
//  thereafter by plan code from configuration
//  (subscription-plans.config.ts). This client only knows how to create
//  and list them; it has no opinion on whether that happens once at
//  setup time or is re-run idempotently — that decision, and why, lives
//  in the Subscription Billing batch report.
// ─────────────────────────────────────────

interface PaystackPlanData {
  plan_code: string;
  name: string;
  amount: number;
  interval: string;
  currency: string;
  [key: string]: unknown;
}

export interface CreatePlanParams {
  name: string;
  amountCents: number;
  // Paystack's own interval vocabulary (per their current docs: daily,
  // weekly, monthly, quarterly, annually) — passed through verbatim
  // rather than re-typed as a narrower union, since this client has no
  // opinion on which intervals a caller uses.
  interval: string;
  currency?: string;
  description?: string;
}

export interface PaystackPlan {
  planCode: string;
  name: string;
  amountCents: number;
  interval: string;
  currency: string;
}

const toPlan = (data: PaystackPlanData): PaystackPlan => ({
  planCode: data.plan_code,
  name: data.name,
  amountCents: data.amount,
  interval: data.interval,
  currency: data.currency,
});

export const createPlan = async (params: CreatePlanParams): Promise<PaystackPlan> => {
  const data = await paystackRequest<PaystackPlanData>('POST', '/plan', {
    name: params.name,
    amount: params.amountCents,
    interval: params.interval,
    currency: params.currency ?? 'ZAR',
    ...(params.description !== undefined && { description: params.description }),
  });
  return toPlan(data);
};

export const listPlans = async (): Promise<PaystackPlan[]> => {
  const data = await paystackRequest<PaystackPlanData[]>('GET', '/plan?perPage=100');
  return data.map(toPlan);
};

// ─────────────────────────────────────────
//  SUBSCRIPTIONS
//
//  Paystack owns the renewal schedule entirely — this client only ever
//  creates or disables a subscription in reaction to a tenant's own
//  request; it never runs on a timer. See subscription.service.ts.
// ─────────────────────────────────────────

// Paystack is NOT consistent about this shape across endpoints, unlike
// most of its other resources — confirmed against the real test API
// while building this batch, not assumed from docs. POST /subscription
// (create) returns customer/plan/authorization as BARE NUMERIC IDS
// (e.g. "customer": 399123022), while GET /subscription/:code and the
// subscription.create WEBHOOK both return the fuller nested objects
// ("customer": { "customer_code": "CUS_...", "email": "..." }). toSubscription
// below handles both, extracting what it can and leaving a field null
// only when a bare id genuinely has nothing else to read.
interface PaystackSubscriptionData {
  subscription_code: string;
  email_token: string;
  next_payment_date: string;
  status: string;
  customer: { customer_code: string; email: string } | number;
  plan: { plan_code: string } | string | number;
  authorization?: {
    authorization_code: string;
    last4: string;
    card_type: string;
    exp_month: string;
    exp_year: string;
  } | number;
  [key: string]: unknown;
}

export interface CreateSubscriptionParams {
  // The customer to subscribe — Paystack accepts either the numeric
  // customer id or the customer_code; this client always passes the
  // code, since that's the only one callers ever have on hand (never
  // the numeric id, which this codebase doesn't store).
  customerCode: string;
  planCode: string;
  // Which saved card to charge — omitted lets Paystack pick the
  // customer's most recent reusable authorization, per their own
  // documented default. Passed explicitly whenever the caller already
  // knows which one (e.g. reusing the card from an existing
  // subscription for an upgrade).
  authorizationCode?: string;
}

export interface PaystackSubscription {
  subscriptionCode: string;
  emailToken: string;
  nextPaymentDate: string;
  status: string;
  // null when the response only carried a bare numeric id (POST
  // /subscription's own response — see PaystackSubscriptionData's
  // comment) rather than the fuller nested object (GET
  // /subscription/:code and the subscription.create webhook both give
  // the real code). A caller that needs it unconditionally should read
  // it from GET /subscription/:code (getSubscription below) instead.
  customerCode: string | null;
  planCode: string | null;
  authorizationCode: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  cardExpMonth: string | null;
  cardExpYear: string | null;
}

const toSubscription = (data: PaystackSubscriptionData): PaystackSubscription => {
  const customer = typeof data.customer === 'object' ? data.customer : null;
  const authorization = typeof data.authorization === 'object' ? data.authorization : null;
  const planCode = typeof data.plan === 'string' ? data.plan : typeof data.plan === 'object' ? data.plan.plan_code : null;

  return {
    subscriptionCode: data.subscription_code,
    emailToken: data.email_token,
    nextPaymentDate: data.next_payment_date,
    status: data.status,
    customerCode: customer?.customer_code ?? null,
    planCode,
    authorizationCode: authorization?.authorization_code ?? null,
    cardLast4: authorization?.last4 ?? null,
    cardBrand: authorization?.card_type ?? null,
    cardExpMonth: authorization?.exp_month ?? null,
    cardExpYear: authorization?.exp_year ?? null,
  };
};

// Used for an upgrade that reuses an existing saved card — the tenant
// has already authorised a card via a prior Initialize Transaction, so
// this charges it immediately for the new plan with no checkout
// redirect. NOT used for a tenant's first-ever subscribe, which goes
// through initializeTransaction with a `plan` param instead (that's
// the only way to collect a NEW card — see subscription.service.ts).
export const createSubscription = async (params: CreateSubscriptionParams): Promise<PaystackSubscription> => {
  const data = await paystackRequest<PaystackSubscriptionData>('POST', '/subscription', {
    customer: params.customerCode,
    plan: params.planCode,
    ...(params.authorizationCode !== undefined && { authorization: params.authorizationCode }),
  });
  return toSubscription(data);
};

// Paystack requires BOTH the subscription code and its email_token to
// disable a subscription (a deliberate anti-tamper pairing — knowing
// the code alone isn't enough to cancel someone else's subscription).
export const disableSubscription = async (subscriptionCode: string, emailToken: string): Promise<void> => {
  await paystackRequest<{ status: boolean }>('POST', '/subscription/disable', {
    code: subscriptionCode,
    token: emailToken,
  });
};

// Fetches the CURRENT authoritative state of a subscription — used
// after a renewal's charge.success to learn the fresh next_payment_date,
// which that webhook event does not itself carry (only
// subscription.create does, and Paystack does not resend that event on
// each renewal — see subscription.service.ts's own comment on this).
// Never used to compute a period end ourselves; only to read the one
// Paystack already computed.
export const getSubscription = async (subscriptionCode: string): Promise<PaystackSubscription> => {
  const data = await paystackRequest<PaystackSubscriptionData>('GET', `/subscription/${encodeURIComponent(subscriptionCode)}`);
  return toSubscription(data);
};

interface PaystackManageLinkData {
  link: string;
}

// "Generate Update Subscription Link" — the one Paystack-native way to
// let a customer replace the card on an EXISTING subscription. Neither
// initializeTransaction (a fresh checkout, no subscription to attach
// to) nor createSubscription (a new subscription, i.e. a second one
// alongside the failing one) does this: this returns a hosted Paystack
// page, scoped to this one subscription, where Paystack captures the
// new card and swaps it in as the subscription's authorization —
// nothing about the card ever reaches this backend.
export const generateSubscriptionManageLink = async (subscriptionCode: string): Promise<string> => {
  const data = await paystackRequest<PaystackManageLinkData>(
    'GET',
    `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`
  );
  return data.link;
};
