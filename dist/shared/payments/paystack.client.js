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
    constructor(paystackMessage, httpStatus) {
        super(`Paystack request failed (${httpStatus}): ${paystackMessage}`);
        this.name = 'PaystackApiError';
        this.paystackMessage = paystackMessage;
        this.httpStatus = httpStatus;
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
        throw new PaystackApiError(`Could not reach Paystack: ${reason}`, 0);
    }
    let json;
    try {
        json = (await response.json());
    }
    catch {
        throw new PaystackApiError('Paystack returned a non-JSON response', response.status);
    }
    if (!response.ok || !json.status) {
        throw new PaystackApiError(json.message || 'Unknown Paystack error', response.status);
    }
    return json.data;
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
//# sourceMappingURL=paystack.client.js.map