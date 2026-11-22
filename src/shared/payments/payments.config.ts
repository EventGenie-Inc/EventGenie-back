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
// e.g. "2", "2.5", "10". Anything else (empty, "2%", "abc") is
// rejected rather than passed to parseFloat, which would silently
// accept garbage like "2abc" as 2.
const COMMISSION_PERCENT_PATTERN = /^\d+(\.\d{1,2})?$/;

// Commission rate (2% since the pilot), expressed as integer basis points (2% -> 200) so
// money.util.ts's applyBasisPoints never has to multiply a cents amount
// by a float percentage. Parsed via string splitting, not
// parseFloat(...) * 100 — the same reasoning as money.util.ts's
// decimalToCents: a percent read from .env is still text, and turning
// it into basis points is itself a place float error could sneak in if
// done by multiplication instead of string arithmetic.
export const getPlatformCommissionBasisPoints = (): number => {
  const raw = process.env.PLATFORM_COMMISSION_PERCENT;

  if (!raw || !COMMISSION_PERCENT_PATTERN.test(raw)) {
    throw new Error(
      `PLATFORM_COMMISSION_PERCENT is missing or invalid in .env (got ${JSON.stringify(raw ?? null)}) — ` +
      'expected a plain non-negative number with at most 2 decimal places, e.g. "2".'
    );
  }

  const [whole, frac = ''] = raw.split('.') as [string, string | undefined];
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, '0'), 10);
};

export const getPaystackPublicKey = (): string => {
  const key = process.env.PAYSTACK_PUBLIC_KEY;
  if (!key) throw new Error('PAYSTACK_PUBLIC_KEY is not defined in .env');
  return key;
};

// ─────────────────────────────────────────
//  TICKET FEES (ticket sales Round A, 2026-11)
//
//  Paystack's South African local card fee, and e-velope's own fixed fee
//  per ticket order, as configuration rather than code: Paystack can change
//  its price or negotiate ours, and a new value is then a setting, not a
//  release. The defaults are Paystack's published local card rate
//  (paystack.com/za/pricing, read 2026-11): 2.9% + R1, VAT exclusive, with
//  South Africa's 15% VAT on top. Read on every calculation, so a change
//  needs no restart beyond the environment's own.
//
//  PAYSTACK_LOCAL_CARD_FEE_PERCENT   "2.9"   (at most 2 decimals)
//  PAYSTACK_LOCAL_CARD_FLAT_FEE_CENTS "100"  (R1.00)
//  PAYSTACK_FEE_VAT_PERCENT          "15"
//  PLATFORM_TICKET_FIXED_FEE_CENTS   "0"     (per order, on top of the 2%)
//  PLATFORM_COMMISSION_PERCENT       (above; 2)
// ─────────────────────────────────────────

export interface TicketFeeConfig {
  // e-velope's commission on the ticket subtotal, in basis points (2% = 200).
  commissionBasisPoints: number;
  // e-velope's fixed fee per order, in cents.
  platformFixedFeeCents: number;
  // Paystack's percentage, in basis points (2.9% = 290), before VAT.
  paystackFeeBasisPoints: number;
  // Paystack's flat fee per payment, in cents, before VAT.
  paystackFlatFeeCents: number;
  // VAT charged on Paystack's fee, in basis points (15% = 1500).
  paystackVatBasisPoints: number;
}

const percentToBasisPoints = (name: string, raw: string): number => {
  if (!COMMISSION_PERCENT_PATTERN.test(raw)) {
    throw new Error(`${name} is invalid (got ${JSON.stringify(raw)}): expected a plain non-negative number with at most 2 decimal places, e.g. "2.9".`);
  }
  const [whole, frac = ''] = raw.split('.') as [string, string | undefined];
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, '0'), 10);
};

const percentFromEnv = (name: string, fallback: string): number => percentToBasisPoints(name, process.env[name]?.trim() || fallback);

const centsFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} is invalid (got ${JSON.stringify(raw)}): expected a whole number of cents, e.g. "100".`);
  return parseInt(raw, 10);
};

export const DEFAULT_PAYSTACK_LOCAL_CARD_FEE_PERCENT = '2.9';
export const DEFAULT_PAYSTACK_LOCAL_CARD_FLAT_FEE_CENTS = 100;
export const DEFAULT_PAYSTACK_FEE_VAT_PERCENT = '15';
export const DEFAULT_PLATFORM_TICKET_FIXED_FEE_CENTS = 0;

export const getTicketFeeConfig = (): TicketFeeConfig => {
  const config: TicketFeeConfig = {
    commissionBasisPoints: getPlatformCommissionBasisPoints(),
    platformFixedFeeCents: centsFromEnv('PLATFORM_TICKET_FIXED_FEE_CENTS', DEFAULT_PLATFORM_TICKET_FIXED_FEE_CENTS),
    paystackFeeBasisPoints: percentFromEnv('PAYSTACK_LOCAL_CARD_FEE_PERCENT', DEFAULT_PAYSTACK_LOCAL_CARD_FEE_PERCENT),
    paystackFlatFeeCents: centsFromEnv('PAYSTACK_LOCAL_CARD_FLAT_FEE_CENTS', DEFAULT_PAYSTACK_LOCAL_CARD_FLAT_FEE_CENTS),
    paystackVatBasisPoints: percentFromEnv('PAYSTACK_FEE_VAT_PERCENT', DEFAULT_PAYSTACK_FEE_VAT_PERCENT),
  };
  // Paystack's whole rate, VAT included, must leave something of each rand.
  if (config.paystackFeeBasisPoints * (10_000 + config.paystackVatBasisPoints) >= 10_000 * 10_000) {
    throw new Error('PAYSTACK_LOCAL_CARD_FEE_PERCENT with its VAT is 100% or more: ticket prices could never be grossed up.');
  }
  return config;
};
