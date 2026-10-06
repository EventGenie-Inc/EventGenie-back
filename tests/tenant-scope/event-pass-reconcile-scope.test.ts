import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
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
//  Event Pass reconcile routes — scoped to the event in the URL and the
//  caller's tenant.
//
//    POST /api/events/:eventId/pass/purchases/:purchaseId/reconcile
//    POST /api/events/:eventId/pass/sms-bundle/purchases/:purchaseId/reconcile
//
//  Both used to look the purchase up by id alone, so any tenant admin could
//  reconcile (and so trigger a Paystack verify and a confirm for) any
//  tenant's purchase. Purchases here are FAILED, so a found purchase answers
//  200 with its status and no Paystack call is ever made.
// ─────────────────────────────────────────

type Actor = { id: string; firebaseUid: string; email: string; role: 'TENANT_ADMIN'; tenantId: string };

const tokens = new Map<string, string>();
const headersFor = (actor: Actor) => {
  const firebaseToken = `reconcile-scope-${actor.id}`;
  tokens.set(firebaseToken, actor.firebaseUid);
  const session = jwt.sign(
    { userId: actor.id, firebaseUid: actor.firebaseUid, email: actor.email, role: actor.role, tenantId: actor.tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${firebaseToken}`, 'X-Session-Token': session };
};

const actorFrom = (u: { id: string; firebaseUid: string; email: string }, tenantId: string): Actor =>
  ({ id: u.id, firebaseUid: u.firebaseUid, email: u.email, role: 'TENANT_ADMIN', tenantId });

let tenantA: string;
let tenantB: string;
let adminA: Actor;
let adminB: Actor;
let eventA1: string;
let eventA2: string;
let eventB: string;
// Purchases on event A1 (tenant A) and on event B (tenant B).
let passA1: string;
let bundleA1: string;
let passB: string;
let bundleB: string;

const createPurchases = async (eventId: string, tenantId: string) => {
  const pass = await prisma.eventPassPurchase.create({
    data: { eventId, tenantId, passTier: 'SMALL', amountPaidCents: 39_900, status: 'FAILED' },
  });
  const bundle = await prisma.eventSmsBundlePurchase.create({
    data: { eventId, tenantId, smsCount: 10, amountPaidCents: 2_220, status: 'FAILED' },
  });
  return { pass: pass.id, bundle: bundle.id };
};

beforeAll(async () => {
  tenantA = (await createTestTenant()).id;
  tenantB = (await createTestTenant()).id;
  const a = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenantA });
  const b = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenantB });
  adminA = actorFrom(a, tenantA);
  adminB = actorFrom(b, tenantB);
  eventA1 = (await createTestEvent(tenantA, a.id)).id;
  eventA2 = (await createTestEvent(tenantA, a.id)).id;
  eventB = (await createTestEvent(tenantB, b.id)).id;
  ({ pass: passA1, bundle: bundleA1 } = await createPurchases(eventA1, tenantA));
  ({ pass: passB, bundle: bundleB } = await createPurchases(eventB, tenantB));
}, 90000);

afterAll(async () => {
  for (const eventId of [eventA1, eventA2, eventB]) {
    await prisma.eventPassPurchase.deleteMany({ where: { eventId } });
    await prisma.eventSmsBundlePurchase.deleteMany({ where: { eventId } });
    await deleteTestEvent(eventId);
  }
  await deleteTestUserRow(adminA.id);
  await deleteTestUserRow(adminB.id);
  await deleteTestTenant(tenantA);
  await deleteTestTenant(tenantB);
}, 90000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens.get(token);
    if (uid) return { uid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
});

const passUrl = (eventId: string, purchaseId: string) => `/api/events/${eventId}/pass/purchases/${purchaseId}/reconcile`;
const bundleUrl = (eventId: string, purchaseId: string) => `/api/events/${eventId}/pass/sms-bundle/purchases/${purchaseId}/reconcile`;

describe.each([
  { kind: 'Event Pass', url: passUrl, own: () => passA1, foreign: () => passB },
  { kind: 'SMS bundle', url: bundleUrl, own: () => bundleA1, foreign: () => bundleB },
])('$kind reconcile', ({ url, own, foreign }) => {
  it('the owner reconciles its own purchase under its own event (control)', async () => {
    const res = await request(app).post(url(eventA1, own())).set(headersFor(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'FAILED' });
  }, 30000);

  it("another tenant's purchase, under the caller's own event: 404", async () => {
    const res = await request(app).post(url(eventA1, foreign())).set(headersFor(adminA));
    expect(res.status).toBe(404);
  }, 30000);

  it("another tenant's purchase, under that tenant's event: 404", async () => {
    const res = await request(app).post(url(eventB, foreign())).set(headersFor(adminA));
    expect(res.status).toBe(404);
  }, 30000);

  it("same tenant, another event's purchase: 404", async () => {
    const res = await request(app).post(url(eventA2, own())).set(headersFor(adminA));
    expect(res.status).toBe(404);
  }, 30000);

  it('tenant B cannot reach tenant A\'s purchase either way', async () => {
    const res = await request(app).post(url(eventA1, own())).set(headersFor(adminB));
    expect(res.status).toBe(404);
  }, 30000);
});
