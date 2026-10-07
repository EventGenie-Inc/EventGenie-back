import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import app, { GENERIC_ERROR_MESSAGE } from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { OTP_TOKEN_INVALID_MESSAGE } from '../../src/modules/auth/auth.service.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';

// ─────────────────────────────────────────
//  The sign-in code steps with a Firebase token Firebase refuses (expired,
//  revoked, malformed): POST /api/auth/request-otp and /verify-otp answer
//  401 "please sign in again", like register. Both used to call
//  verifyIdToken with nothing catching its error, so a token that expired
//  while the person read their email reached the global handler as a 500.
//  A Firebase failure that ISN'T about the token (an outage) is still a 500.
// ─────────────────────────────────────────

let user: TestUser;

beforeAll(async () => {
  user = await createTestTenantAndUser();
}, 60000);

afterAll(async () => {
  await prisma.otpRecord.deleteMany({ where: { userId: user.id } });
  await prisma.deviceToken.deleteMany({ where: { userId: user.id } });
  await deleteTestTenantAndUser(user);
}, 60000);

const firebaseError = (code: string) => Object.assign(new Error(`Firebase: ${code}`), { code });

// A fresh client IP per request (app.ts trusts one proxy hop), so the
// per-IP request-otp/verify-otp limiters, 5 and 10 per 15 minutes, never
// answer 429 here — the same approach as password-reset-link.test.ts.
let requestNo = 0;
const post = (path: string) =>
  request(app).post(path).set('Authorization', 'Bearer some-token').set('X-Forwarded-For', `198.51.100.${++requestNo}`);

const ROUTES = {
  'request-otp': () => post('/api/auth/request-otp').send(),
  'verify-otp': () => post('/api/auth/verify-otp').send({ otp: '123456' }),
} as const;

const REJECTIONS = ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/argument-error', 'auth/invalid-id-token'];

describe.each(Object.keys(ROUTES) as (keyof typeof ROUTES)[])('POST /api/auth/%s — the Firebase token', (route) => {
  it.each(REJECTIONS)('%s is a 401 asking them to sign in again, not a 500', async (code) => {
    mockVerifyIdToken.mockRejectedValueOnce(firebaseError(code));
    const before = await prisma.otpRecord.count({ where: { userId: user.id } });

    const res = await ROUTES[route]();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: 'error', message: OTP_TOKEN_INVALID_MESSAGE });
    // Refused before anything happened: no code issued or consumed.
    expect(await prisma.otpRecord.count({ where: { userId: user.id } })).toBe(before);
  }, 30000);

  it('a Firebase failure that is not about the token stays a 500 (the control: outages are not masked as 401)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockVerifyIdToken.mockRejectedValueOnce(firebaseError('app/network-error'));
    const res = await ROUTES[route]();
    vi.restoreAllMocks();
    expect(res.status).toBe(500);
    expect(res.body.message).toBe(GENERIC_ERROR_MESSAGE);
  }, 30000);
});

describe('a valid token still gets through (the control)', () => {
  it('request-otp sends a code', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: user.firebaseUid });
    const res = await ROUTES['request-otp']();
    expect(res.status).toBe(200);
  }, 30000);

  it('verify-otp reaches the code check (a wrong code is 400, not 401)', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: user.firebaseUid });
    const res = await post('/api/auth/verify-otp').send({ otp: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid or expired verification code.');
  }, 30000);
});
