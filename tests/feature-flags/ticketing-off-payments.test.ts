import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  LAUNCH MODE — with ticketing OFF, the money paths that are not ticket
//  sales keep working: buying an Event Pass, the Paystack webhook that
//  confirms it, and the subscription routes. They share Paystack with
//  ticketing but don't belong to it.
//
//  Paystack's initializeTransaction is the one stubbed boundary (no real
//  network call); the webhook is signed with the real PAYSTACK_SECRET_KEY
//  exactly as Paystack signs it, and goes through the real signature check.
// ─────────────────────────────────────────

const mockInitializeTransaction = vi.fn();

vi.mock('../../src/shared/payments/paystack.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/payments/paystack.client.js')>();
  return { ...actual, initializeTransaction: (...args: unknown[]) => mockInitializeTransaction(...args) };
});

type Actor = { id: string; firebaseUid: string; email: string; role: 'TENANT_ADMIN'; tenantId: string };

const tokens = new Map<string, string>();
const headersFor = (actor: Actor) => {
  const firebaseToken = `ticketing-off-${actor.id}`;
  tokens.set(firebaseToken, actor.firebaseUid);
  const session = jwt.sign(
    { userId: actor.id, firebaseUid: actor.firebaseUid, email: actor.email, role: actor.role, tenantId: actor.tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${firebaseToken}`, 'X-Session-Token': session };
};

const signedWebhook = (payload: unknown) => {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY as string).update(body).digest('hex');
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', signature)
    .send(body);
};

let tenantId: string;
let admin: Actor;
let eventId: string;

beforeAll(async () => {
  tenantId = (await createTestTenant()).id;
  const u = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
  admin = { id: u.id, firebaseUid: u.firebaseUid, email: u.email, role: 'TENANT_ADMIN', tenantId };
  eventId = (await createTestEvent(tenantId, u.id)).id;
}, 60000);

afterAll(async () => {
  // Fixture cleanup on the test database only. The ledger is append-only
  // in the product; these rows never existed from the product's view.
  const refs = (await prisma.eventPassPurchase.findMany({ where: { eventId }, select: { paymentRef: true } })).map((p) => p.paymentRef);
  await prisma.paymentLedgerEntry.deleteMany({ where: { OR: [{ eventId }, { paystackReference: { in: refs } }] } });
  await prisma.paystackWebhookEvent.deleteMany({ where: { dedupeKey: { in: refs.map((r) => `charge.success:${r}`) } } });
  await prisma.eventPassPurchase.deleteMany({ where: { eventId } });
  await prisma.eventPass.deleteMany({ where: { eventId } });
  await deleteTestEvent(eventId);
  await deleteTestUserRow(admin.id);
  await deleteTestTenant(tenantId);
}, 60000);

beforeEach(() => {
  vi.stubEnv('FEATURES_DISABLED', 'ticketing');
  mockInitializeTransaction.mockReset();
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens.get(token);
    if (uid) return { uid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ticketing off — Event Pass purchase and the Paystack webhook still work', () => {
  it('buys a pass, then the signed charge.success webhook confirms it', async () => {
    mockInitializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.test/abc', accessCode: 'abc', reference: 'ignored' });

    const purchase = await request(app)
      .post(`/api/events/${eventId}/pass/purchase`)
      .set(headersFor(admin))
      .send({ passTier: 'SMALL' });
    expect(purchase.status).toBe(200);
    expect(purchase.body.data.authorizationUrl).toBe('https://checkout.paystack.test/abc');
    expect(mockInitializeTransaction).toHaveBeenCalledTimes(1);

    const row = await prisma.eventPassPurchase.findFirstOrThrow({ where: { eventId } });
    expect(row.status).toBe('PENDING');

    const hook = await signedWebhook({
      event: 'charge.success',
      data: { reference: row.paymentRef, amount: row.amountPaidCents, currency: 'ZAR', status: 'success' },
    });
    expect(hook.status).toBe(200);
    expect(hook.body.outcome).toBe('processed');

    const confirmed = await prisma.eventPassPurchase.findUniqueOrThrow({ where: { id: row.id } });
    expect(confirmed.status).toBe('PAID');
    const pass = await prisma.eventPass.findUnique({ where: { eventId } });
    expect(pass?.passTier).toBe('SMALL');
  }, 90000);

  it('the webhook still rejects a bad signature (the route is live, not hidden)', async () => {
    const res = await request(app)
      .post('/api/payments/webhook')
      .set('x-paystack-signature', 'nope')
      .send({ event: 'charge.success', data: {} });
    expect(res.status).toBe(401);
  }, 30000);

  it('subscription routes still answer', async () => {
    const plans = await request(app).get('/api/subscriptions/plans').set(headersFor(admin));
    expect(plans.status).toBe(200);
    const status = await request(app).get('/api/subscriptions').set(headersFor(admin));
    expect(status.status).toBe(200);
  }, 30000);
});
