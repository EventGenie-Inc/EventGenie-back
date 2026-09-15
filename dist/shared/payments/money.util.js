import { Prisma } from '@prisma/client';
// ─────────────────────────────────────────
//  MONEY — THE Decimal <-> CENTS BOUNDARY
//
//  Ticket.price, VendorSpace/Product pricing, etc. are stored as Prisma
//  Decimal — correct for storage, wrong for arithmetic in JavaScript
//  (Decimal arrives as an object; JSON.stringify renders it as a
//  STRING via its own toJSON, and there is no +/-/* on it directly).
//
//  This file is the ONLY place a Decimal-backed monetary column may be
//  turned into a number anywhere in this codebase's payments code, and
//  the only place a number may be turned back into one. Every function
//  below works in whole cents using integer/string arithmetic — never
//  Number(decimal) * 100, which reintroduces exactly the float error
//  this boundary exists to eliminate (0.1 + 0.2 !== 0.3, and a payment
//  system that hits that is not a curiosity, it's an unexplained
//  reconciliation gap three months from now).
//
//  Everything on the far side of decimalToCents — every payments
//  function, the Paystack client, the ledger — deals exclusively in
//  integer cents. Nothing past this boundary may touch a Decimal, a
//  float amount, or Number(decimal) again.
// ─────────────────────────────────────────
export const DEFAULT_CURRENCY = 'ZAR';
// Decimal.toFixed(2) returns a canonical, exactly-2-decimal-place string
// ("19.99", "200.00", "-5.00") regardless of how the value was
// constructed or how many digits it actually carries — decimal.js does
// the rounding internally, in decimal arithmetic, before we ever see a
// string. Splitting that string and parsing the two halves as integers
// keeps every step of this conversion in exact string/integer
// operations; no float division or multiplication ever runs.
export const decimalToCents = (amount) => {
    const decimal = amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);
    const fixed = decimal.toFixed(2);
    const negative = fixed.startsWith('-');
    const unsigned = negative ? fixed.slice(1) : fixed;
    const [whole, frac] = unsigned.split('.');
    const cents = parseInt(whole, 10) * 100 + parseInt(frac, 10);
    return negative ? -cents : cents;
};
// The one place cents are allowed to cross back into a Decimal-shaped
// string, for writing into a Decimal column or displaying a rand value.
// Pure integer arithmetic — no division, so no float remainder either.
export const centsToDecimalString = (cents) => {
    const truncated = Math.trunc(cents);
    const negative = truncated < 0;
    const abs = Math.abs(truncated);
    const whole = Math.floor(abs / 100);
    const frac = abs % 100;
    return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
};
// Integer-safe application of a basis-point rate (1% = 100 basis
// points) to a cents amount — e.g. commission = applyBasisPoints(
// ticketPriceCents, getPlatformCommissionBasisPoints() ). basisPoints
// itself is parsed from configuration as an integer in
// payments.config.ts (never a float percent multiplied in directly),
// so the only rounding step anywhere in this computation is the single,
// unavoidable one below — not a compounding one.
export const applyBasisPoints = (amountCents, basisPoints) => Math.round((amountCents * basisPoints) / 10_000);
// ─────────────────────────────────────────
//  GROSS-UP
//
//  Solves for the TOTAL T a payer must be charged so that, after a
//  percentage-based fee is deducted from T itself (not from the amount
//  the recipient needs to net), the recipient still nets exactly
//  `amountToPreserveCents`. This is NOT the same as adding the fee
//  percentage on top of the target amount — that undercharges, because
//  the fee then gets computed on a total that's too small. Naming the
//  fee rate f and the target amount A:
//
//      T = A + f*T   =>   T*(1-f) = A   =>   T = A / (1-f)
//
//  feePpm is the fee rate in parts-per-million (1% = 10,000ppm) rather
//  than basis points — a card-processing rate compounded with VAT (e.g.
//  2.9% * 1.15 = 3.335%) needs a 3rd decimal digit of percent precision
//  that basis points (2 digits) can't represent exactly; ppm can. Used
//  by ticket-purchase-pricing.util.ts for the Paystack fee gross-up.
//
//  Both operands stay well within Number.MAX_SAFE_INTEGER for any
//  realistic cents amount, so — same reasoning as applyBasisPoints —
//  the division below is a single correctly-rounded IEEE754 operation
//  on exact integers, not compounding float error.
export const grossUpForFeeRate = (amountToPreserveCents, feePpm) => Math.round((amountToPreserveCents * 1_000_000) / (1_000_000 - feePpm));
//# sourceMappingURL=money.util.js.map