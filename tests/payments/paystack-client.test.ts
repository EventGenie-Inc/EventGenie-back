import { describe, it, expect } from 'vitest';
import {
  verifyTransaction,
  initializeTransaction,
  describePaystackFailure,
  isUncertainPaystackFailure,
  assertPaystackKeyMode,
  PaystackApiError,
} from '../../src/shared/payments/paystack.client.js';
import { toPaymentHttpError, PAYMENT_PROVIDER_UNAVAILABLE, PAYMENT_REJECTED } from '../../src/shared/payments/payment-errors.util.js';
import { fakePaystack } from '../helpers/fake-paystack.js';

// ─────────────────────────────────────────
//  THE PAYSTACK CLIENT (payments release 1): every call has a timeout;
//  reads are retried on a timeout, a network error, 429 and 5xx, writes
//  never; failures are classified once; users get neutral messages; and
//  the key must match the environment. Against the fake Paystack.
// ─────────────────────────────────────────

const errorOf = async (p: Promise<unknown>): Promise<PaystackApiError> => {
  try {
    await p;
  } catch (err) {
    return err as PaystackApiError;
  }
  throw new Error('expected a failure');
};

describe('timeouts and failures, classified', () => {
  it('a timeout is a timeout, and uncertain', async () => {
    fakePaystack.addTransaction({ reference: 'ref_timeout', amount: 100, email: 'a@b.test' });
    fakePaystack.failNext('GET /transaction/verify', 'timeout', 3);
    const err = await errorOf(verifyTransaction('ref_timeout'));
    expect(err).toBeInstanceOf(PaystackApiError);
    expect(err.kind).toBe('timeout');
    expect(isUncertainPaystackFailure(err)).toBe(true);
  });

  it('a 400 is a rejection, certain, and not retried', async () => {
    const err = await errorOf(verifyTransaction('ref_unknown'));
    expect(err.kind).toBe('rejected');
    expect(isUncertainPaystackFailure(err)).toBe(false);
    expect(fakePaystack.callsTo('GET', '/transaction/verify')).toHaveLength(1);
  });

  it('a 429 is rate_limited, a 503 is server', async () => {
    fakePaystack.failNext('GET /transaction/verify', { status: 429 }, 3);
    expect((await errorOf(verifyTransaction('x'))).kind).toBe('rate_limited');
    fakePaystack.failNext('GET /transaction/verify', { status: 503 }, 3);
    expect((await errorOf(verifyTransaction('x'))).kind).toBe('server');
  });
});

describe('retries', () => {
  it('a read is retried after a 5xx, a 429 or a timeout, and succeeds', async () => {
    fakePaystack.addTransaction({ reference: 'ref_retry', amount: 100, email: 'a@b.test' });
    fakePaystack.failNext('GET /transaction/verify', { status: 502 });
    fakePaystack.failNext('GET /transaction/verify', 'timeout');
    const result = await verifyTransaction('ref_retry');
    expect(result.reference).toBe('ref_retry');
    expect(fakePaystack.callsTo('GET', '/transaction/verify')).toHaveLength(3);
  });

  it('gives up after two retries', async () => {
    fakePaystack.failNext('GET /transaction/verify', { status: 500 }, 10);
    await errorOf(verifyTransaction('ref_x'));
    expect(fakePaystack.callsTo('GET', '/transaction/verify')).toHaveLength(3);
  });

  it('a write is never retried: a timed-out initialize is tried once', async () => {
    fakePaystack.failNext('POST /transaction/initialize', 'timeout');
    const err = await errorOf(initializeTransaction({ email: 'a@b.test', amountCents: 100, reference: 'ref_once' }));
    expect(err.kind).toBe('timeout');
    expect(fakePaystack.callsTo('POST', '/transaction/initialize')).toHaveLength(1);
  });
});

describe('neutral messages', () => {
  it("users never see Paystack's own text", async () => {
    fakePaystack.failNext('POST /transaction/initialize', { status: 401, body: { status: false, message: 'Invalid key' } });
    const rejected = describePaystackFailure(await errorOf(initializeTransaction({ email: 'a@b.test', amountCents: 100, reference: 'r1' })));
    const rejectedError = toPaymentHttpError(rejected, 'config');
    expect(rejectedError.statusCode).toBe(422);
    expect(rejectedError.code).toBe(PAYMENT_REJECTED);
    expect(rejectedError.message).not.toMatch(/Invalid key/);

    fakePaystack.failNext('POST /transaction/initialize', 'network');
    const network = describePaystackFailure(await errorOf(initializeTransaction({ email: 'a@b.test', amountCents: 100, reference: 'r2' })));
    const networkError = toPaymentHttpError(network, 'config');
    expect(networkError.statusCode).toBe(503);
    expect(networkError.code).toBe(PAYMENT_PROVIDER_UNAVAILABLE);
    expect(networkError.message).not.toMatch(/fetch failed|Paystack/);

    // Paystack never reached (a missing plan code): our configuration, a 500.
    expect(toPaymentHttpError(describePaystackFailure(new Error('PAYSTACK_PLAN_X is not defined')), 'Something went wrong').statusCode).toBe(500);
  });
});

describe('key mode', () => {
  it('production needs live keys; every other environment needs test keys', () => {
    expect(() => assertPaystackKeyMode({ STORAGE_ENV: 'prod', PAYSTACK_SECRET_KEY: 'sk_live_abc', PAYSTACK_PUBLIC_KEY: 'pk_live_abc' })).not.toThrow();
    expect(() => assertPaystackKeyMode({ STORAGE_ENV: 'prod', PAYSTACK_SECRET_KEY: 'sk_test_abc' })).toThrow(/live key/);
    expect(() => assertPaystackKeyMode({ STORAGE_ENV: 'prod', PAYSTACK_SECRET_KEY: 'sk_live_abc', PAYSTACK_PUBLIC_KEY: 'pk_test_abc' })).toThrow(/PAYSTACK_PUBLIC_KEY/);
    expect(() => assertPaystackKeyMode({ STORAGE_ENV: 'staging', PAYSTACK_SECRET_KEY: 'sk_test_abc' })).not.toThrow();
    expect(() => assertPaystackKeyMode({ STORAGE_ENV: 'staging', PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow(/test key/);
    expect(() => assertPaystackKeyMode({ STORAGE_ENV: 'dev', PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow(/test key/);
  });

  it('the message never carries the key', () => {
    try {
      assertPaystackKeyMode({ STORAGE_ENV: 'prod', PAYSTACK_SECRET_KEY: 'sk_test_SECRETVALUE' });
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRETVALUE');
    }
  });
});
