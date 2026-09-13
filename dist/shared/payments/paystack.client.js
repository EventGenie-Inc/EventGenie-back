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
    throw new Error('PAYSTACK_SECRET_KEY is not defined in .env — the payments module cannot start without it.');
}
// Re-assigned to a const of a narrowed type so every call site below
// gets `string`, not `string | undefined`, without a non-null
// assertion at each use.
const SECRET_KEY = PAYSTACK_SECRET_KEY;
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
    paystackMessage;
    httpStatus;
    // The exact response body Paystack (or a description of a network/
    // parse failure when there wasn't one) returned — never rebuilt or
    // paraphrased. Callers that write a PaymentLedgerEntry for a failed
    // charge attempt must store THIS, not just `paystackMessage`: a
    // dispute investigated months from now needs the real bytes Paystack
    // sent, not our own summary of them. See describePaystackFailure
    // below, which every payment-initiating call site should route
    // through rather than hand-rolling this extraction again.
    raw;
    constructor(paystackMessage, httpStatus, raw) {
        super(`Paystack request failed (${httpStatus}): ${paystackMessage}`);
        this.name = 'PaystackApiError';
        this.paystackMessage = paystackMessage;
        this.httpStatus = httpStatus;
        this.raw = raw;
    }
}
const paystackRequest = async (method, path, body) => {
    let response;
    try {
        response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        });
    }
    catch (networkError) {
        const reason = networkError instanceof Error ? networkError.message : 'Unknown network error';
        throw new PaystackApiError(`Could not reach Paystack: ${reason}`, 0, { networkError: reason });
    }
    // Read as text FIRST, not response.json() directly — a body can only
    // be consumed once, and a non-JSON or malformed-JSON response must
    // still have its raw text preserved on the thrown error rather than
    // being reduced to a made-up string, for the exact same "store what
    // actually came back" reason as the parsed-JSON case below.
    const rawText = await response.text();
    let json = null;
    try {
        json = JSON.parse(rawText);
    }
    catch {
        json = null;
    }
    if (!response.ok || !json || !json.status) {
        throw new PaystackApiError(json?.message || 'Unknown Paystack error', response.status, json ?? { nonJsonBody: rawText });
    }
    return json.data;
};
export const describePaystackFailure = (err) => {
    if (err instanceof PaystackApiError) {
        return {
            isPaystackRejection: true,
            summary: err.paystackMessage,
            raw: { httpStatus: err.httpStatus, body: err.raw },
        };
    }
    const summary = err instanceof Error ? err.message : String(err);
    return {
        isPaystackRejection: false,
        summary,
        raw: { message: summary, stack: err instanceof Error ? err.stack : undefined },
    };
};
export const initializeTransaction = async (params) => {
    const data = await paystackRequest('POST', '/transaction/initialize', {
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
export const verifyTransaction = async (reference) => {
    const data = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
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
const toSubaccountResult = (data) => ({
    subaccountCode: data.subaccount_code,
    businessName: data.business_name,
    settlementBank: data.settlement_bank,
    accountNumber: data.account_number,
    active: data.active,
    raw: data,
});
export const createSubaccount = async (params) => {
    const data = await paystackRequest('POST', '/subaccount', {
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
export const updateSubaccount = async (subaccountCode, params) => {
    const data = await paystackRequest('PUT', `/subaccount/${encodeURIComponent(subaccountCode)}`, {
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
export const getSubaccount = async (subaccountCode) => {
    const data = await paystackRequest('GET', `/subaccount/${encodeURIComponent(subaccountCode)}`);
    return toSubaccountResult(data);
};
export const listBanks = async (params) => {
    const query = new URLSearchParams({
        country: params?.country ?? 'south africa',
        currency: params?.currency ?? 'ZAR',
    });
    const data = await paystackRequest('GET', `/bank?${query.toString()}`);
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
export const verifyWebhookSignature = (rawBody, signatureHeader) => {
    if (!signatureHeader || Array.isArray(signatureHeader))
        return false;
    const expected = crypto.createHmac('sha512', SECRET_KEY).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(signatureHeader, 'utf8');
    // timingSafeEqual throws on mismatched lengths rather than returning
    // false, so that has to be checked first — a length mismatch is
    // itself a definitive "not equal", not an error condition.
    if (expectedBuf.length !== receivedBuf.length)
        return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
};
const toPlan = (data) => ({
    planCode: data.plan_code,
    name: data.name,
    amountCents: data.amount,
    interval: data.interval,
    currency: data.currency,
});
export const createPlan = async (params) => {
    const data = await paystackRequest('POST', '/plan', {
        name: params.name,
        amount: params.amountCents,
        interval: params.interval,
        currency: params.currency ?? 'ZAR',
        ...(params.description !== undefined && { description: params.description }),
    });
    return toPlan(data);
};
export const listPlans = async () => {
    const data = await paystackRequest('GET', '/plan?perPage=100');
    return data.map(toPlan);
};
const toSubscription = (data) => {
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
export const createSubscription = async (params) => {
    const data = await paystackRequest('POST', '/subscription', {
        customer: params.customerCode,
        plan: params.planCode,
        ...(params.authorizationCode !== undefined && { authorization: params.authorizationCode }),
    });
    return toSubscription(data);
};
// Paystack requires BOTH the subscription code and its email_token to
// disable a subscription (a deliberate anti-tamper pairing — knowing
// the code alone isn't enough to cancel someone else's subscription).
export const disableSubscription = async (subscriptionCode, emailToken) => {
    await paystackRequest('POST', '/subscription/disable', {
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
export const getSubscription = async (subscriptionCode) => {
    const data = await paystackRequest('GET', `/subscription/${encodeURIComponent(subscriptionCode)}`);
    return toSubscription(data);
};
// "Generate Update Subscription Link" — the one Paystack-native way to
// let a customer replace the card on an EXISTING subscription. Neither
// initializeTransaction (a fresh checkout, no subscription to attach
// to) nor createSubscription (a new subscription, i.e. a second one
// alongside the failing one) does this: this returns a hosted Paystack
// page, scoped to this one subscription, where Paystack captures the
// new card and swaps it in as the subscription's authorization —
// nothing about the card ever reaches this backend.
export const generateSubscriptionManageLink = async (subscriptionCode) => {
    const data = await paystackRequest('GET', `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`);
    return data.link;
};
//# sourceMappingURL=paystack.client.js.map