import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { ROUTE_NOT_FOUND_BODY } from '../../src/shared/middleware/feature.middleware.js';
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
//  FREE PILOT — `payments` off. Every route that starts or changes a
//  payment is a 404 (the global 404 body, like any switched-off feature);
//  the read-only billing routes and the Paystack webhook keep working, so a
//  payment started before the switch still lands.
//
//  Paystack's initializeTransaction is the one stubbed boundary; the
//  webhook is signed with the real PAYSTACK_SECRET_KEY and goes through the
//  real signature check.
// ─────────────────────────────────────────

const mockInitializeTransaction = vi.fn();

vi.mock('../../src/shared/payments/paystack.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/payments/paystack.client.js')>();
  return { ...actual, initializeTransaction: (...args: unknown[]) => mockInitializeTransaction(...args) };
});

type Actor = { id: string; firebaseUid: string; email: string; role: 'TENANT_ADMIN'; tenantId: string };

const tokens = new Map<string, string>();
const headersFor = (actor: Actor) => {
  const firebaseToken = `payments-off-${actor.id}`;
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
  vi.stubEnv('FEATURES_DISABLED', 'payments');
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

const PAYMENT_ROUTES: { name: string; method: 'get' | 'post' | 'put'; path: () => string; body?: object }[] = [
  { name: 'subscribe', method: 'post', path: () => '/api/subscriptions/subscribe', body: { tier: 'CELEBRATE', period: 'MONTHLY' } },
  { name: 'change tier', method: 'put', path: () => '/api/subscriptions/change-tier', body: { tier: 'ELEVATE', period: 'MONTHLY' } },
  { name: 'cancel', method: 'post', path: () => '/api/subscriptions/cancel' },
  { name: 'update card link', method: 'get', path: () => '/api/subscriptions/update-card-link' },
  { name: 'Event Pass purchase', method: 'post', path: () => `/api/events/${eventId}/pass/purchase`, body: { passTier: 'SMALL' } },
  { name: 'Event Pass reconcile', method: 'post', path: () => `/api/events/${eventId}/pass/purchases/00000000-0000-0000-0000-000000000000/reconcile` },
  { name: 'SMS bundle purchase', method: 'post', path: () => `/api/events/${eventId}/pass/sms-bundle/purchase`, body: { credits: 100 } },
  { name: 'SMS bundle reconcile', method: 'post', path: () => `/api/events/${eventId}/pass/sms-bundle/purchases/00000000-0000-0000-0000-000000000000/reconcile` },
];

describe('payments off — every route that starts or changes a payment is a 404', () => {
  for (const route of PAYMENT_ROUTES) {
    it(`${route.name}: 404 with the global 404 body, Paystack never called`, async () => {
      const res = await request(app)[route.method](route.path()).set(headersFor(admin)).send(route.body ?? {});
      expect(res.status).toBe(404);
      expect(res.body).toEqual(ROUTE_NOT_FOUND_BODY);
      expect(mockInitializeTransaction).not.toHaveBeenCalled();
    }, 30000);
  }

  it('with payments on, the same routes are not the switched-off 404 (the flag is what refuses them)', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    mockInitializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.test/x', accessCode: 'x', reference: 'ignored' });
    for (const route of PAYMENT_ROUTES) {
      const res = await request(app)[route.method](route.path()).set(headersFor(admin)).send(route.body ?? {});
      expect(res.body, route.name).not.toEqual(ROUTE_NOT_FOUND_BODY);
    }
    // Clean up the pending pass purchase that succeeded above, so the
    // webhook test below starts from nothing.
    await prisma.eventPassPurchase.deleteMany({ where: { eventId } });
  }, 120000);
});

describe('payments off — the read-only routes and the webhook keep working', () => {
  it('current plan, plans, billing history and pass status all answer 200', async () => {
    const headers = headersFor(admin);
    expect((await request(app).get('/api/subscriptions').set(headers)).status).toBe(200);
    expect((await request(app).get('/api/subscriptions/plans').set(headers)).status).toBe(200);
    expect((await request(app).get('/api/billing-history').set(headers)).status).toBe(200);
    expect((await request(app).get(`/api/events/${eventId}/pass`).set(headers)).status).toBe(200);
  }, 60000);

  it('a pass bought before the switch is confirmed by the signed webhook after it', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    mockInitializeTransaction.mockResolvedValue({ authorizationUrl: 'https://checkout.paystack.test/abc', accessCode: 'abc', reference: 'ignored' });
    const purchase = await request(app).post(`/api/events/${eventId}/pass/purchase`).set(headersFor(admin)).send({ passTier: 'SMALL' });
    expect(purchase.status).toBe(200);
    const row = await prisma.eventPassPurchase.findFirstOrThrow({ where: { eventId } });

    vi.stubEnv('FEATURES_DISABLED', 'payments');
    const hook = await signedWebhook({
      event: 'charge.success',
      data: { reference: row.paymentRef, amount: row.amountPaidCents, currency: 'ZAR', status: 'success' },
    });
    expect(hook.status).toBe(200);
    expect(hook.body.outcome).toBe('processed');
    expect((await prisma.eventPassPurchase.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PAID');
    expect((await prisma.eventPass.findUnique({ where: { eventId } }))?.passTier).toBe('SMALL');
  }, 90000);

  it('the webhook still checks its signature (the route is live, not hidden)', async () => {
    const res = await request(app).post('/api/payments/webhook').set('x-paystack-signature', 'nope').send({ event: 'charge.success', data: {} });
    expect(res.status).toBe(401);
  }, 30000);

  it('/api/config/features reports payments: false', async () => {
    const res = await request(app).get('/api/config/features');
    expect(res.body.data.payments).toBe(false);
  });
});
