// ─────────────────────────────────────────
//  PAYMENTS CONFIGURATION
//
//  Reads payment-related environment variables. PAYSTACK_SECRET_KEY is
//  validated eagerly in paystack.client.ts (that one must crash startup
//  — see its own comment). The two values here are validated lazily, on
//  first read, because nothing in this foundation batch calls them yet:
//  ticketing (not built here) is what will actually apply the commission
//  rate, and PAYSTACK_PUBLIC_KEY is only ever handed to a frontend, never
//  used in a server-side computation. Failing loudly the moment code
//  finally does read them is enough — there is no "silently no-op" risk
//  for a value nothing consumes yet.
// ─────────────────────────────────────────
// Matches a plain non-negative number with at most 2 decimal places —
// e.g. "2.5", "2.55", "10". Anything else (empty, "2.5%", "abc") is
// rejected rather than passed to parseFloat, which would silently
// accept garbage like "2.5abc" as 2.5.
const COMMISSION_PERCENT_PATTERN = /^\d+(\.\d{1,2})?$/;
// Commission rate, expressed as integer basis points (2.5% -> 250) so
// money.util.ts's applyBasisPoints never has to multiply a cents amount
// by a float percentage. Parsed via string splitting, not
// parseFloat(...) * 100 — the same reasoning as money.util.ts's
// decimalToCents: a percent read from .env is still text, and turning
// it into basis points is itself a place float error could sneak in if
// done by multiplication instead of string arithmetic.
export const getPlatformCommissionBasisPoints = () => {
    const raw = process.env.PLATFORM_COMMISSION_PERCENT;
    if (!raw || !COMMISSION_PERCENT_PATTERN.test(raw)) {
        throw new Error(`PLATFORM_COMMISSION_PERCENT is missing or invalid in .env (got ${JSON.stringify(raw ?? null)}) — ` +
            'expected a plain non-negative number with at most 2 decimal places, e.g. "2.5".');
    }
    const [whole, frac = ''] = raw.split('.');
    return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, '0'), 10);
};
export const getPaystackPublicKey = () => {
    const key = process.env.PAYSTACK_PUBLIC_KEY;
    if (!key)
        throw new Error('PAYSTACK_PUBLIC_KEY is not defined in .env');
    return key;
};
//# sourceMappingURL=payments.config.js.map