import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';
import { issueDeviceToken, revokeDeviceTokenByValue } from '../../src/modules/auth/device-token.util.js';

// ─────────────────────────────────────────
//  Auth guard suite — the guarantees this batch's report argues for:
//  Firebase token alone is never enough, a device token is bound to one
//  user, revocation actually revokes, a suspended user is refused
//  cleanly (not a masked 500), and the raw device token is never at
//  rest. See tests/setup.ts for how Firebase is stubbed and
//  tests/helpers/db.ts for how fixtures are built.
//
//  Token-string convention in this file: the "Firebase ID token" sent on
//  the wire is just a label string ('firebase-token-a' etc.) — the mock
//  maps labels to decoded UIDs via mockImplementation, so a test can
//  simulate two different callers without any real Firebase involved.
// ─────────────────────────────────────────

let userA: TestUser;
let userB: TestUser;
let suspendedUser: TestUser;

const FIREBASE_TOKEN_A = 'firebase-token-a';
const FIREBASE_TOKEN_B = 'firebase-token-b';
const FIREBASE_TOKEN_SUSPENDED = 'firebase-token-suspended';

beforeAll(async () => {
  userA = await createTestTenantAndUser();
  userB = await createTestTenantAndUser();
  suspendedUser = await createTestTenantAndUser({ isActive: false });
});

// tests/setup.ts's own global beforeEach calls mockVerifyIdToken.mockReset()
// before every test (so a one-off mockResolvedValueOnce in some OTHER test
// file can never leak into the next test) — that reset also wipes any
// mockImplementation, so it must be re-applied here, in this file's own
// beforeEach, which Vitest runs AFTER the global one. A beforeAll alone
// would only ever survive the very first test.
beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    if (token === FIREBASE_TOKEN_A) return { uid: userA.firebaseUid };
    if (token === FIREBASE_TOKEN_B) return { uid: userB.firebaseUid };
    if (token === FIREBASE_TOKEN_SUSPENDED) return { uid: suspendedUser.firebaseUid };
    const err = new Error('Decoding Firebase ID token failed') as Error & { code: string };
    err.code = 'auth/argument-error';
    throw err;
  });
});

afterAll(async () => {
  await deleteTestTenantAndUser(userA);
  await deleteTestTenantAndUser(userB);
  await deleteTestTenantAndUser(suspendedUser);
  await prisma.$disconnect();
});

describe('POST /api/auth/exchange-session', () => {
  it('refuses a Firebase token with no device token — 401, no session', async () => {
    const res = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', 'Bearer irrelevant-not-mocked-to-succeed')
      .send({ deviceToken: '' });

    // Empty deviceToken is caught by the router's own presence check
    // before authService.exchangeSession runs at all.
    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
  });

  it('refuses a Firebase token paired with a garbage device token — 401, code DEVICE_NOT_RECOGNISED', async () => {
    const res = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_A}`)
      .send({ deviceToken: 'f'.repeat(64) });

    expect(res.status).toBe(401);
    expect(res.body.status).toBe('error');
    expect(res.body.code).toBe('DEVICE_NOT_RECOGNISED');
    expect(res.body.data).toBeUndefined();
  });

  it('refuses another user\'s device token with the SAME response (status, body, code) as garbage — no oracle', async () => {
    const { token: bDeviceToken } = await issueDeviceToken(userB.id);

    const garbage = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_A}`)
      .send({ deviceToken: 'f'.repeat(64) });

    const wrongUser = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_A}`)
      .send({ deviceToken: bDeviceToken });

    expect(wrongUser.status).toBe(401);
    expect(wrongUser.status).toBe(garbage.status);
    expect(wrongUser.body).toEqual(garbage.body);
    expect(wrongUser.body.code).toBe('DEVICE_NOT_RECOGNISED');
  });

  it('refuses an invalid Firebase token — 401, code FIREBASE_TOKEN_INVALID, distinct from the device code', async () => {
    const res = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', 'Bearer this-token-is-not-one-of-the-mocked-ones')
      .send({ deviceToken: 'f'.repeat(64) });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('FIREBASE_TOKEN_INVALID');
    expect(res.body.code).not.toBe('DEVICE_NOT_RECOGNISED');
  });

  it('refuses a missing Authorization header — 401, code FIREBASE_TOKEN_INVALID', async () => {
    const res = await request(app).post('/api/auth/exchange-session').send({ deviceToken: 'f'.repeat(64) });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('FIREBASE_TOKEN_INVALID');
  });

  it('mints a session for a valid pair, and that session works on an authenticated route', async () => {
    const { token: aDeviceToken } = await issueDeviceToken(userA.id);

    const exchange = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_A}`)
      .send({ deviceToken: aDeviceToken });

    expect(exchange.status).toBe(200);
    expect(typeof exchange.body.data.sessionToken).toBe('string');
    expect(exchange.body.data.user.id).toBe(userA.id);

    const me = await request(app)
      .get('/api/tenants/me')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_A}`)
      .set('X-Session-Token', exchange.body.data.sessionToken);

    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(userA.tenantId);
  });

  it('refuses an expired device token — 401', async () => {
    const { token: rawToken } = await issueDeviceToken(userA.id);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await prisma.deviceToken.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_A}`)
      .send({ deviceToken: rawToken });

    expect(res.status).toBe(401);
  });

  it('refuses a suspended user even with a valid device token — 403, not 500', async () => {
    const { token: rawToken } = await issueDeviceToken(suspendedUser.id);

    const res = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_SUSPENDED}`)
      .send({ deviceToken: rawToken });

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
  });

  it('stores only the hash — the raw token never appears in the DeviceToken table', async () => {
    const { token: rawToken } = await issueDeviceToken(userA.id);

    const byRawValue = await prisma.deviceToken.findUnique({ where: { tokenHash: rawToken } });
    expect(byRawValue).toBeNull();

    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const byHash = await prisma.deviceToken.findUnique({ where: { tokenHash: expectedHash } });
    expect(byHash).not.toBeNull();
    expect(byHash!.userId).toBe(userA.id);

    const allRows = await prisma.deviceToken.findMany({ where: { userId: userA.id } });
    for (const row of allRows) {
      expect(row.tokenHash).not.toBe(rawToken);
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the device token; double logout and a garbage token both still 200', async () => {
    const { token: rawToken } = await issueDeviceToken(userA.id);

    const logoutRes = await request(app).post('/api/auth/logout').send({ deviceToken: rawToken });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await request(app)
      .post('/api/auth/exchange-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_A}`)
      .send({ deviceToken: rawToken });
    expect(afterLogout.status).toBe(401);

    const doubleLogout = await request(app).post('/api/auth/logout').send({ deviceToken: rawToken });
    expect(doubleLogout.status).toBe(200);

    const garbageLogout = await request(app).post('/api/auth/logout').send({ deviceToken: 'not-a-real-token' });
    expect(garbageLogout.status).toBe(200);
  });
});
