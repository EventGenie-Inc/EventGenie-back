import { describe, it, expect, afterEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { decimalToCents, centsToDecimalString, applyBasisPoints, grossUpForFeeRate } from '../../src/shared/payments/money.util.js';
import { getPlatformCommissionBasisPoints } from '../../src/shared/payments/payments.config.js';
import { computeTicketChargeCents } from '../../src/modules/ticket-purchase/ticket-purchase-pricing.util.js';
import { checkAmount, paidAtOf, transactionIdOf, originalPaymentOf } from '../../src/shared/payments/paystack-payload.util.js';

// ─────────────────────────────────────────
//  MONEY — the Decimal <-> cents boundary, the commission and the gross-up,
//  and the payload checks every confirmation makes (payments release 1).
//  Pure functions: no database, no Paystack.
// ─────────────────────────────────────────

afterEach(() => vi.unstubAllEnvs());

describe('decimalToCents / centsToDecimalString', () => {
  it('converts without float error, both ways', () => {
    expect(decimalToCents(new Prisma.Decimal('19.99'))).toBe(1999);
    expect(decimalToCents('0.1')).toBe(10);
    expect(decimalToCents(new Prisma.Decimal('0.1').plus('0.2'))).toBe(30);
    expect(decimalToCents('200')).toBe(20000);
    expect(decimalToCents('-5.5')).toBe(-550);
    // Rounded to the cent in decimal arithmetic, half away from zero.
    expect(decimalToCents('1.005')).toBe(101);
    expect(centsToDecimalString(1999)).toBe('19.99');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(-550)).toBe('-5.50');
    for (const cents of [0, 1, 99, 100, 12345, 99999999]) {
      expect(decimalToCents(centsToDecimalString(cents))).toBe(cents);
    }
  });
});

describe('commission', () => {
  it('reads PLATFORM_COMMISSION_PERCENT as basis points: 2 is 200', () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    expect(getPlatformCommissionBasisPoints()).toBe(200);
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2.0');
    expect(getPlatformCommissionBasisPoints()).toBe(200);
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2.55');
    expect(getPlatformCommissionBasisPoints()).toBe(255);
  });

  it('refuses anything else', () => {
    for (const bad of ['', '2%', 'abc', '2.555', '-2', '2abc']) {
      vi.stubEnv('PLATFORM_COMMISSION_PERCENT', bad);
      expect(() => getPlatformCommissionBasisPoints()).toThrow(/PLATFORM_COMMISSION_PERCENT/);
    }
  });

  it('applies basis points with one rounding step', () => {
    expect(applyBasisPoints(10000, 200)).toBe(200);
    expect(applyBasisPoints(12345, 200)).toBe(247); // 246.9
    expect(applyBasisPoints(1, 200)).toBe(0);
  });
});

describe('gross-up', () => {
  it('grossUpForFeeRate: the payer total whose fee leaves exactly the target', () => {
    // 3.335% (2.9% card + VAT) on R100.
    const total = grossUpForFeeRate(10000, 33350);
    expect(total).toBe(10345);
    expect(total - Math.round((total * 33350) / 1_000_000)).toBe(10000);
  });

  it('a R100 ticket at 2%: the organiser nets exactly R100, the platform keeps commission plus the fee', () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    const b = computeTicketChargeCents(10000, 1);
    expect(b.ticketPriceCents).toBe(10000);
    expect(b.commissionCents).toBe(200);
    // The smallest T with T − Paystack's fee ≥ 10200, the fee rounded per
    // part as Paystack charges it (ticket-fee-calculator.ts): 10672 −
    // (⌈309.488⌉ + 100 + ⌈61.5⌉) = 10200.
    expect(b.totalChargeCents).toBe(10672);
    expect(b.totalChargeCents - b.platformChargeCents).toBe(10000);
    // Paystack's card fee on T leaves at least the commission.
    const percent = Math.ceil((b.totalChargeCents * 290) / 10_000);
    const fee = percent + 100 + Math.ceil(((percent + 100) * 15) / 100);
    expect(b.platformChargeCents - fee).toBeGreaterThanOrEqual(200);
  });

  it('scales with quantity and never puts rounding on the organiser', () => {
    vi.stubEnv('PLATFORM_COMMISSION_PERCENT', '2');
    for (const [price, qty] of [[1, 1], [999, 3], [25050, 4], [123457, 10]] as const) {
      const b = computeTicketChargeCents(price, qty);
      expect(b.ticketPriceCents).toBe(price * qty);
      expect(b.totalChargeCents - b.platformChargeCents).toBe(price * qty);
      expect(Number.isInteger(b.totalChargeCents)).toBe(true);
    }
  });
});

describe('payload checks', () => {
  it('checkAmount: the exact amount and currency pass; anything else, a missing amount included, fails', () => {
    expect(checkAmount({ amount: 39900, currency: 'ZAR' }, 39900)).toEqual({ ok: true });
    expect(checkAmount({ amount: 39900, currency: 'zar' }, 39900)).toEqual({ ok: true });
    expect(checkAmount({ amount: 100, currency: 'ZAR' }, 39900)).toMatchObject({ ok: false, actualCents: 100 });
    expect(checkAmount({ amount: 39900, currency: 'NGN' }, 39900)).toMatchObject({ ok: false, actualCurrency: 'NGN' });
    expect(checkAmount({ currency: 'ZAR' }, 39900)).toMatchObject({ ok: false, actualCents: null });
    expect(checkAmount({ amount: 39900 }, 39900)).toMatchObject({ ok: false, actualCurrency: null });
  });

  it('reads paid_at and the transaction id', () => {
    expect(paidAtOf({ paid_at: '2026-11-18T10:00:00.000Z' })?.toISOString()).toBe('2026-11-18T10:00:00.000Z');
    expect(paidAtOf({ paidAt: '2026-11-18T10:00:00.000Z' })?.toISOString()).toBe('2026-11-18T10:00:00.000Z');
    expect(paidAtOf({ paid_at: 'not a date' })).toBeUndefined();
    expect(transactionIdOf({ id: 123 })).toBe('123');
    expect(transactionIdOf({})).toBeNull();
  });

  it("finds a refund's or dispute's original payment in every shape", () => {
    expect(originalPaymentOf({ transaction_reference: 'pass_1' })).toEqual({ reference: 'pass_1', transactionId: null });
    expect(originalPaymentOf({ transaction: { id: 9, reference: 'pass_2' } })).toEqual({ reference: 'pass_2', transactionId: '9' });
    expect(originalPaymentOf({ transaction: 77 })).toEqual({ reference: null, transactionId: '77' });
  });
});
