import { describe, it, expect, afterEach, vi } from 'vitest';
import { calculateTicketOrderFees } from '../../src/modules/ticket-sales/ticket-fee-calculator.js';
import { getTicketFeeConfig, type TicketFeeConfig } from '../../src/shared/payments/payments.config.js';

// ─────────────────────────────────────────
//  THE TICKET FEE CALCULATOR (ticket sales Round A)
//
//  One pure function: the guest pays the commission and Paystack's fee on
//  top of the ticket price, grossed up over the whole order (Paystack's
//  flat fee once per payment), and the organiser receives exactly the
//  subtotal. Every number is whole cents.
//
//  Paystack's fee, as the calculator assumes it: (T × 2.9% + R1) × 1.15,
//  rounded up to the cent. `paystackFee` below recomputes it independently.
// ─────────────────────────────────────────

const DEFAULTS: TicketFeeConfig = {
  commissionBasisPoints: 200,
  platformFixedFeeCents: 0,
  paystackFeeBasisPoints: 290,
  paystackFlatFeeCents: 100,
  paystackVatBasisPoints: 1500,
};

const paystackFee = (total: number, c: TicketFeeConfig = DEFAULTS): number =>
  Math.ceil(((total * c.paystackFeeBasisPoints) / 10_000 + c.paystackFlatFeeCents) * (1 + c.paystackVatBasisPoints / 10_000) - 1e-9);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the worked example', () => {
  it('a single R200 ticket: the guest pays R212.23, the organiser receives R200.00', () => {
    const fees = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 }, DEFAULTS);
    expect(fees).toEqual({
      unitPriceCents: 20_000,
      quantity: 1,
      subtotalCents: 20_000,
      commissionCents: 400,
      platformFixedFeeCents: 0,
      processingFeeCents: 823,
      totalCents: 21_223,
      organiserShareCents: 20_000,
      transactionChargeCents: 1_223,
    });
  });

  it('reads the same values from the environment by default (PLATFORM_COMMISSION_PERCENT 2, Paystack 2.9% + R1 + 15% VAT)', () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    expect(getTicketFeeConfig()).toEqual(DEFAULTS);
    expect(calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 }).totalCents).toBe(21_223);
  });
});

describe('every price and quantity', () => {
  const cases: [number, number][] = [
    [1_000, 1], // R10, the least a ticket can cost
    [1_000, 20],
    [5_000, 3],
    [15_050, 4],
    [20_000, 2],
    [99_999, 7],
    [500_000, 1], // R5,000
    [500_000, 20],
  ];

  it.each(cases)('R%s cents × %s: whole cents, the organiser gets exactly the subtotal, and e-velope is never short', (unit, qty) => {
    const f = calculateTicketOrderFees({ unitPriceCents: unit, quantity: qty }, DEFAULTS);
    for (const value of Object.values(f)) expect(Number.isInteger(value)).toBe(true);
    expect(f.subtotalCents).toBe(unit * qty);
    expect(f.organiserShareCents).toBe(f.subtotalCents);
    expect(f.totalCents - f.transactionChargeCents).toBe(f.subtotalCents);
    expect(f.commissionCents).toBe(Math.round((unit * qty * 2) / 100));
    expect(f.subtotalCents + f.commissionCents + f.platformFixedFeeCents + f.processingFeeCents).toBe(f.totalCents);
    // After Paystack's fee, e-velope keeps at least its commission...
    expect(f.totalCents - paystackFee(f.totalCents) - f.subtotalCents).toBeGreaterThanOrEqual(f.commissionCents);
    // ...and the total is the smallest that does: a cent less falls short.
    const less = f.totalCents - 1;
    expect(less - paystackFee(less) - f.subtotalCents).toBeLessThan(f.commissionCents);
  });

  it('R10 and R5,000 come to the totals worked out by hand', () => {
    // R10: (1000 + 20 + 115) / (1 − 0.03335) = 1174.15… → 1175
    expect(calculateTicketOrderFees({ unitPriceCents: 1_000, quantity: 1 }, DEFAULTS).totalCents).toBe(1_175);
    // R5,000: (500000 + 10000 + 115) / 0.96665 = 527714.27… → 527715
    expect(calculateTicketOrderFees({ unitPriceCents: 500_000, quantity: 1 }, DEFAULTS).totalCents).toBe(527_715);
  });
});

describe('the order is grossed up as a whole', () => {
  it("Paystack's flat fee is charged once per order, not once per ticket", () => {
    const one = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 }, DEFAULTS);
    const five = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 5 }, DEFAULTS);
    // Five tickets in one order cost less than five orders of one: the
    // R1.15 flat fee (with VAT) and its gross-up are paid once.
    expect(five.totalCents).toBeLessThan(5 * one.totalCents);
    expect(5 * one.totalCents - five.totalCents).toBeGreaterThanOrEqual(4 * 115);
    // Exactly one flat fee in the order's processing: what's left after the
    // percentage (with VAT) of the total is one flat fee, give or take a cent.
    const percentPart = (five.totalCents * 290 * 1.15) / 10_000;
    expect(five.processingFeeCents - percentPart).toBeGreaterThan(115 - 1);
    expect(five.processingFeeCents - percentPart).toBeLessThan(115 + 2);
  });
});

describe('configuration', () => {
  it('PLATFORM_TICKET_FIXED_FEE_CENTS is added once per order, on top of the commission, and grossed up', () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    vi.stubEnv('PLATFORM_TICKET_FIXED_FEE_CENTS', '500');
    const config = getTicketFeeConfig();
    expect(config.platformFixedFeeCents).toBe(500);
    const withFee = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 3 });
    const without = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 3 }, DEFAULTS);
    expect(withFee.platformFixedFeeCents).toBe(500);
    expect(withFee.organiserShareCents).toBe(60_000);
    // R5 more for e-velope, grossed up: the guest pays a little over R5 more.
    expect(withFee.totalCents - without.totalCents).toBeGreaterThanOrEqual(500);
    expect(withFee.totalCents - without.totalCents).toBeLessThanOrEqual(519);
    expect(withFee.totalCents - paystackFee(withFee.totalCents) - withFee.subtotalCents).toBeGreaterThanOrEqual(withFee.commissionCents + 500);
  });

  it("Paystack's percentage, flat fee and VAT are configuration", () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    vi.stubEnv('PAYSTACK_LOCAL_CARD_FEE_PERCENT', '3.5');
    vi.stubEnv('PAYSTACK_LOCAL_CARD_FLAT_FEE_CENTS', '200');
    vi.stubEnv('PAYSTACK_FEE_VAT_PERCENT', '0');
    const config = getTicketFeeConfig();
    expect(config).toMatchObject({ paystackFeeBasisPoints: 350, paystackFlatFeeCents: 200, paystackVatBasisPoints: 0 });
    const f = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 });
    // (20000 + 400 + 200) / 0.965 = 21347.15… → 21348
    expect(f.totalCents).toBe(21_348);
    expect(f.organiserShareCents).toBe(20_000);
  });

  it('a malformed setting stops the calculation rather than guessing', () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    vi.stubEnv('PLATFORM_TICKET_FIXED_FEE_CENTS', '5.5');
    expect(() => getTicketFeeConfig()).toThrow(/PLATFORM_TICKET_FIXED_FEE_CENTS/);
    vi.stubEnv('PLATFORM_TICKET_FIXED_FEE_CENTS', '0');
    vi.stubEnv('PAYSTACK_LOCAL_CARD_FEE_PERCENT', '2.9%');
    expect(() => getTicketFeeConfig()).toThrow(/PAYSTACK_LOCAL_CARD_FEE_PERCENT/);
  });

  it('refuses a price or quantity that is not whole', () => {
    expect(() => calculateTicketOrderFees({ unitPriceCents: 199.5, quantity: 1 }, DEFAULTS)).toThrow();
    expect(() => calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 0 }, DEFAULTS)).toThrow();
  });
});
