import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';

// ─────────────────────────────────────────
//  auth.middleware.ts — Trusted Devices Hardening batch, Part 4.
//
//  Mirrors the exact bug (and fix) exchange-session.test.ts covers for
//  auth.service.ts's exchangeSession: checkRevoked makes verifyIdToken
//  also check the account's disabled flag, and that specific Firebase
//  error code was previously uncaught here too, falling through to the
//  global handler's masked 500 for ANY authenticated route hit by a
//  suspended user — not just exchange-session.
// ─────────────────────────────────────────

let user: TestUser;
const FIREBASE_TOKEN_DISABLED = 'firebase-token-middleware-disabled';
const FIREBASE_TOKEN_OK = 'firebase-token-middleware-ok';

beforeAll(async () => {
  user = await createTestTenantAndUser();
});

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    if (token === FIREBASE_TOKEN_OK) return { uid: user.firebaseUid };
    if (token === FIREBASE_TOKEN_DISABLED) {
      const err = new Error('The user record has been disabled.') as Error & { code: string };
      err.code = 'auth/user-disabled';
      throw err;
    }
    const err = new Error('Decoding Firebase ID token failed') as Error & { code: string };
    err.code = 'auth/argument-error';
    throw err;
  });
});

afterAll(async () => {
  await deleteTestTenantAndUser(user);
  await prisma.$disconnect();
});

// authenticate's Layer 2 (session JWT) is checked AFTER Layer 1
// (Firebase) in the source, but the mocked verifyIdToken throws before
// the session token is ever read — so a real, otherwise-valid session
// JWT is used here to prove the 403 comes specifically from the
// auth/user-disabled handling, not from a missing/invalid session token
// short-circuiting first.
const validSessionToken = (): string =>
  jwt.sign(
    { userId: user.id, firebaseUid: user.firebaseUid, email: user.email, role: 'TENANT_ADMIN', tenantId: user.tenantId },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' }
  );

describe('authenticate middleware — auth/user-disabled', () => {
  it('maps auth/user-disabled to 403, not a masked 500, on an authenticated route', async () => {
    const res = await request(app)
      .get('/api/tenants/me')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_DISABLED}`)
      .set('X-Session-Token', validSessionToken());

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
    expect(res.body.message).toBe('Account is inactive or has been archived');
  });

  it('sanity check: the same route succeeds for a normal, non-disabled token', async () => {
    const res = await request(app)
      .get('/api/tenants/me')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_OK}`)
      .set('X-Session-Token', validSessionToken());

    expect(res.status).toBe(200);
  });
});
