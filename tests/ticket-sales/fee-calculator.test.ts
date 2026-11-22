import { describe, it, expect, afterEach, vi } from 'vitest';
import { calculateTicketOrderFees, paystackFeeCents } from '../../src/modules/ticket-sales/ticket-fee-calculator.js';
import { getTicketFeeConfig, type TicketFeeConfig } from '../../src/shared/payments/payments.config.js';

// ─────────────────────────────────────────
//  THE TICKET FEE CALCULATOR (ticket sales Round A, rounding as Paystack
//  charges since the follow-ups)
//
//  The guest pays the commission and Paystack's fee on top of the ticket
//  price, grossed up over the whole order (Paystack's flat fee once per
//  payment); the organiser receives exactly the subtotal. Paystack's fee
//  rounds each part up to the cent: ⌈2.9% of T⌉ + R1, then ⌈15% VAT⌉ on that.
//  Every number is whole cents.
// ─────────────────────────────────────────

const DEFAULTS: TicketFeeConfig = {
  commissionBasisPoints: 200,
  platformFixedFeeCents: 0,
  paystackFeeBasisPoints: 290,
  paystackFlatFeeCents: 100,
  paystackVatBasisPoints: 1500,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Paystack's fee", () => {
  it('a real test payment: R999.00 by local card was charged R34.48 in fees', () => {
    // From the Paystack test-mode transaction: ⌈R28.971⌉ = R28.98, + R1 =
    // R29.98, + VAT ⌈R4.497⌉ = R4.50 → R34.48. One rounding of the whole
    // would give R34.47: Paystack rounds each part.
    expect(paystackFeeCents(99_900, DEFAULTS)).toBe(3_448);
  });

  it('rounds each part up, never down', () => {
    // R100: 290 + 100 = 390, VAT 58.5 → 59: 449 (one rounding: 448.5 → 449 too).
    expect(paystackFeeCents(10_000, DEFAULTS)).toBe(449);
    // R10.01: 29.029 → 30, + 100 = 130, VAT 19.5 → 20: 150.
    expect(paystackFeeCents(1_001, DEFAULTS)).toBe(150);
  });
});

describe('the worked example', () => {
  it('a single R200 ticket: the guest pays R212.24, the organiser receives R200.00', () => {
    const fees = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 }, DEFAULTS);
    expect(fees).toEqual({
      unitPriceCents: 20_000,
      quantity: 1,
      subtotalCents: 20_000,
      commissionCents: 400,
      platformFixedFeeCents: 0,
      processingFeeCents: 824,
      totalCents: 21_224,
      organiserShareCents: 20_000,
      transactionChargeCents: 1_224,
    });
    // Paystack's fee on R212.24 is exactly the processing: nothing over.
    expect(paystackFeeCents(21_224, DEFAULTS)).toBe(824);
  });

  it('reads the same values from the environment by default (PLATFORM_COMMISSION_PERCENT 2, Paystack 2.9% + R1 + 15% VAT)', () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    expect(getTicketFeeConfig()).toEqual(DEFAULTS);
    expect(calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 }).totalCents).toBe(21_224);
  });
});

describe('every price and quantity', () => {
  // R10 to R5,000, 1 to 20 tickets: every price step a little irregular, so
  // the rounding lands every way.
  const prices: number[] = [];
  for (let cents = 1_000; cents <= 500_000; cents += 3_331) prices.push(cents);
  prices.push(500_000, 99_900, 20_000, 1_001, 1_099);

  it('e-velope is never short, never more than a cent over, and the organiser always gets the subtotal', () => {
    let checked = 0;
    for (const unit of prices) {
      for (let qty = 1; qty <= 20; qty++) {
        const f = calculateTicketOrderFees({ unitPriceCents: unit, quantity: qty }, DEFAULTS);
        const needed = f.subtotalCents + f.commissionCents + f.platformFixedFeeCents;
        const kept = f.totalCents - paystackFeeCents(f.totalCents, DEFAULTS);
        expect(kept, `${unit} × ${qty}`).toBeGreaterThanOrEqual(needed);
        expect(kept - needed, `${unit} × ${qty}`).toBeLessThanOrEqual(1);
        expect(f.organiserShareCents).toBe(unit * qty);
        expect(f.totalCents - f.transactionChargeCents).toBe(f.subtotalCents);
        expect(f.subtotalCents + f.commissionCents + f.platformFixedFeeCents + f.processingFeeCents).toBe(f.totalCents);
        for (const value of Object.values(f)) expect(Number.isInteger(value), `${unit} × ${qty}`).toBe(true);
        // The smallest such total: a cent less falls short.
        const less = f.totalCents - 1;
        expect(less - paystackFeeCents(less, DEFAULTS), `${unit} × ${qty}`).toBeLessThan(needed);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3_000);
  });

  it('R10 and R5,000 come to the totals worked out by hand', () => {
    // R10: target 1020. 1175 − ⌈34.075⌉ − 100 − ⌈20.25⌉ = 1019; 1176 → 1020.
    expect(calculateTicketOrderFees({ unitPriceCents: 1_000, quantity: 1 }, DEFAULTS).totalCents).toBe(1_176);
    // R5,000: target 510000. 527715 − (15304 + 100 + 2311) = 510000.
    expect(calculateTicketOrderFees({ unitPriceCents: 500_000, quantity: 1 }, DEFAULTS).totalCents).toBe(527_715);
  });
});

describe('the order is grossed up as a whole', () => {
  it("Paystack's flat fee is charged once per order, not once per ticket", () => {
    const one = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 }, DEFAULTS);
    const five = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 5 }, DEFAULTS);
    // Five in one order cost less than five orders of one: the R1.15 flat
    // fee (with VAT) is paid once.
    expect(5 * one.totalCents - five.totalCents).toBeGreaterThanOrEqual(4 * 115);
    // The order's Paystack fee holds exactly one flat fee: ⌈2.9% of T⌉ + R1
    // and VAT on that, never R5.
    const percent = Math.ceil((five.totalCents * 290) / 10_000);
    expect(paystackFeeCents(five.totalCents, DEFAULTS)).toBe(percent + 100 + Math.ceil(((percent + 100) * 15) / 100));
    expect(five.processingFeeCents - paystackFeeCents(five.totalCents, DEFAULTS)).toBeLessThanOrEqual(1);
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
    expect(withFee.totalCents - without.totalCents).toBeGreaterThanOrEqual(500);
    expect(withFee.totalCents - without.totalCents).toBeLessThanOrEqual(520);
    expect(withFee.totalCents - paystackFeeCents(withFee.totalCents, config) - withFee.subtotalCents).toBeGreaterThanOrEqual(withFee.commissionCents + 500);
  });

  it("Paystack's percentage, flat fee and VAT are configuration", () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    vi.stubEnv('PAYSTACK_LOCAL_CARD_FEE_PERCENT', '3.5');
    vi.stubEnv('PAYSTACK_LOCAL_CARD_FLAT_FEE_CENTS', '200');
    vi.stubEnv('PAYSTACK_FEE_VAT_PERCENT', '0');
    const config = getTicketFeeConfig();
    expect(config).toMatchObject({ paystackFeeBasisPoints: 350, paystackFlatFeeCents: 200, paystackVatBasisPoints: 0 });
    const f = calculateTicketOrderFees({ unitPriceCents: 20_000, quantity: 1 });
    // 21348 − (⌈747.18⌉ + 200) = 20400.
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
