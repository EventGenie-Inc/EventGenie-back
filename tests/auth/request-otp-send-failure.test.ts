import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockVerifyIdToken, mockResendSend } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';

// ─────────────────────────────────────────
//  A SIGN-IN CODE THAT WASN'T SENT IS NOT "SENT"
//
//  POST /api/auth/request-otp used to answer "Verification code sent" even
//  when the email failed, and the user waited for nothing. Now it is a 503
//  with code OTP_SEND_FAILED and a plain message; the provider's reason
//  stays in the server log. Telling the caller leaks nothing: they have
//  already passed the password step.
// ─────────────────────────────────────────

let user: TestUser;
const FIREBASE_TOKEN = 'otp-send-failure-firebase-token';

beforeAll(async () => {
  user = await createTestTenantAndUser();
});

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    if (token === FIREBASE_TOKEN) return { uid: user.firebaseUid };
    throw Object.assign(new Error('Decoding Firebase ID token failed'), { code: 'auth/argument-error' });
  });
});

afterAll(async () => {
  await deleteTestTenantAndUser(user);
  await prisma.$disconnect();
});

const requestOtp = () => request(app).post('/api/auth/request-otp').set('Authorization', `Bearer ${FIREBASE_TOKEN}`).send();

describe('POST /api/auth/request-otp when the email cannot be sent', () => {
  it('Resend reports an error: 503 OTP_SEND_FAILED with a plain message, reason logged server-side only', async () => {
    mockResendSend.mockResolvedValueOnce({ data: null, error: { message: 'domain not verified: provider-secret-detail' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await requestOtp();
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        status: 'error',
        message: "We couldn't send your code. Try again in a moment.",
        code: 'OTP_SEND_FAILED',
      });
      expect(JSON.stringify(res.body)).not.toContain('provider-secret-detail');
      expect(log.mock.calls.flat().join(' ')).toContain('provider-secret-detail');
    } finally {
      log.mockRestore();
    }
  });

  it('Resend throws (network): the same 503', async () => {
    mockResendSend.mockRejectedValueOnce(new Error('ECONNRESET'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await requestOtp();
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('OTP_SEND_FAILED');
    } finally {
      log.mockRestore();
    }
  });

  it('a successful send still answers 200 "code sent"', async () => {
    const res = await requestOtp();
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Verification code sent to your email.');
    expect(res.body.data.otpExpiresAt).toEqual(expect.any(String));
  });
});
