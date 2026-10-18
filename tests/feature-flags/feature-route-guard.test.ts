import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
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
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  LAUNCH MODE — a switched-off feature's routes 404 for a tenant and
//  still work for a SUPER_ADMIN.
//
//  Real Express app and test database; only Firebase's verifyIdToken is
//  stubbed (tests/setup.ts). Each case runs with the flag ON first (the
//  tenant gets a real answer, so the route exists and the 404 below is the
//  flag, not a typo in the path), then OFF (tenant: the global 404 body,
//  byte for byte; SUPER_ADMIN: the same real answer as before).
// ─────────────────────────────────────────

type Actor = { id: string; firebaseUid: string; email: string; role: 'SUPER_ADMIN' | 'TENANT_ADMIN'; tenantId: string | null };

const tokens = new Map<string, string>();

const headersFor = (actor: Actor) => {
  const firebaseToken = `feature-guard-${actor.id}`;
  tokens.set(firebaseToken, actor.firebaseUid);
  const session = jwt.sign(
    { userId: actor.id, firebaseUid: actor.firebaseUid, email: actor.email, role: actor.role, tenantId: actor.tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${firebaseToken}`, 'X-Session-Token': session };
};

let tenantId: string;
let tenantAdmin: Actor;
let superAdmin: Actor;
let eventId: string;

beforeAll(async () => {
  tenantId = (await createTestTenant()).id;
  const ta = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId });
  const sa = await createTestUserRow({ role: 'SUPER_ADMIN' });
  tenantAdmin = { id: ta.id, firebaseUid: ta.firebaseUid, email: ta.email, role: 'TENANT_ADMIN', tenantId };
  superAdmin = { id: sa.id, firebaseUid: sa.firebaseUid, email: sa.email, role: 'SUPER_ADMIN', tenantId: null };
  eventId = (await createTestEvent(tenantId, ta.id)).id;
}, 60000);

afterAll(async () => {
  await deleteTestEvent(eventId);
  await deleteTestUserRow(tenantAdmin.id);
  await deleteTestUserRow(superAdmin.id);
  await deleteTestTenant(tenantId);
}, 60000);

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    const uid = tokens.get(token);
    if (uid) return { uid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOT_FOUND = { status: 'error', message: 'Route not found' };

// One authenticated GET per feature. Each is a read the tenant admin and
// the super admin can both legitimately make with the feature on.
const CASES: { feature: string; path: () => string }[] = [
  { feature: 'ticketing', path: () => `/api/events/${eventId}/tickets` },
  { feature: 'vendors', path: () => '/api/vendors' },
  { feature: 'invitationDesigns', path: () => `/api/events/${eventId}/invitation-design` },
  { feature: 'sms', path: () => `/api/events/${eventId}/pass/sms-bundle` },
  { feature: 'teamMembers', path: () => '/api/users' },
];

describe.each(CASES)('$feature switched off', ({ feature, path }) => {
  it('flag on: the tenant admin reaches the route', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const res = await request(app).get(path()).set(headersFor(tenantAdmin));
    expect(res.status).toBe(200);
  }, 30000);

  it('flag off: 404 for the tenant admin, identical to a route that does not exist', async () => {
    vi.stubEnv('FEATURES_DISABLED', feature);
    const res = await request(app).get(path()).set(headersFor(tenantAdmin));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  }, 30000);

  it('flag off: the super admin still reaches it', async () => {
    vi.stubEnv('FEATURES_DISABLED', feature);
    const res = await request(app).get(path()).set(headersFor(superAdmin));
    expect(res.status).toBe(200);
  }, 30000);
});

describe('ticketing switched off — payout bank details', () => {
  it('flag on: the tenant admin reaches GET /api/payments/subaccount', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const res = await request(app).get('/api/payments/subaccount').set(headersFor(tenantAdmin));
    expect(res.status).not.toBe(404);
  }, 30000);

  it('flag off: 404', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    const res = await request(app).get('/api/payments/subaccount').set(headersFor(tenantAdmin));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  }, 30000);
});

describe('ticketing switched off — guest ticket routes (public)', () => {
  it('flag on: /rsvp/ticket-quote is a real route (400 on an empty body, not 404)', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const res = await request(app).post('/api/rsvp/ticket-quote').send({});
    expect(res.status).toBe(400);
  }, 30000);

  it('flag off: /rsvp/ticket-quote 404s', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    const res = await request(app).post('/api/rsvp/ticket-quote').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  }, 30000);
});

describe('publicEvents switched off — share link', () => {
  it('flag on: the tenant admin gets the route\'s own answer (this event is private), not 404', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const res = await request(app).get(`/api/events/${eventId}/share-link`).set(headersFor(tenantAdmin));
    expect(res.status).toBe(400);
  }, 30000);

  it('flag off: 404 for the tenant admin, the route\'s own answer for the super admin', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    const tenantRes = await request(app).get(`/api/events/${eventId}/share-link`).set(headersFor(tenantAdmin));
    expect(tenantRes.status).toBe(404);
    expect(tenantRes.body).toEqual(NOT_FOUND);
    const superRes = await request(app).get(`/api/events/${eventId}/share-link`).set(headersFor(superAdmin));
    expect(superRes.status).toBe(400);
  }, 30000);
});

describe('vendors switched off — tenant limits', () => {
  it('GET /api/tenants/me has vendorSpaceLimit only while vendors is on', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const on = await request(app).get('/api/tenants/me').set(headersFor(tenantAdmin));
    expect(on.status).toBe(200);
    expect(on.body.data).toHaveProperty('vendorSpaceLimit');

    vi.stubEnv('FEATURES_DISABLED', 'vendors');
    const off = await request(app).get('/api/tenants/me').set(headersFor(tenantAdmin));
    expect(off.status).toBe(200);
    expect(off.body.data).not.toHaveProperty('vendorSpaceLimit');
  }, 30000);
});
