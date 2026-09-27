import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';

// ─────────────────────────────────────────
//  refreshSession — Trusted Devices Hardening batch, Part 5: upgraded to
//  the strict (checkRevoked) Firebase verify, with auth/user-disabled
//  mapped to the same 403 as everywhere else (mirrors the exchangeSession
//  fix from Part 4/the earlier batch). See auth.service.ts's own comment
//  on verifyFirebaseTokenStrict for why refreshSession needed this: a
//  reset-revoked Firebase token must not be able to keep refreshing an
//  already-open session.
// ─────────────────────────────────────────

let user: TestUser;
const FIREBASE_TOKEN_OK = 'firebase-token-refresh-ok';
const FIREBASE_TOKEN_DISABLED = 'firebase-token-refresh-disabled';

beforeAll(async () => {
  user = await createTestTenantAndUser();
});

beforeEach(() => {
  // Sensitive to checkRevoked (2nd arg), matching real Firebase Admin
  // SDK behaviour: verifyIdToken only surfaces auth/user-disabled when
  // checkRevoked is true. This makes the revert-and-fail proof for
  // "refreshSession now uses the strict verify" meaningful — a revert to
  // the lenient verifyFirebaseToken (which never passes true) would make
  // this mock resolve normally instead of throwing, exactly like real
  // Firebase would, catching the actual regression instead of a
  // superficial one.
  mockVerifyIdToken.mockImplementation(async (token: string, checkRevoked?: boolean) => {
    if (token === FIREBASE_TOKEN_OK) return { uid: user.firebaseUid };
    if (token === FIREBASE_TOKEN_DISABLED) {
      if (!checkRevoked) return { uid: user.firebaseUid };
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

const currentSessionToken = (): string =>
  jwt.sign(
    { userId: user.id, firebaseUid: user.firebaseUid, email: user.email, role: 'TENANT_ADMIN', tenantId: user.tenantId },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' }
  );

describe('POST /api/auth/refresh-session', () => {
  it('refreshes normally for a healthy account', async () => {
    const res = await request(app)
      .post('/api/auth/refresh-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_OK}`)
      .set('X-Session-Token', currentSessionToken());

    expect(res.status).toBe(200);
    expect(typeof res.body.data.sessionToken).toBe('string');
  });

  it('maps auth/user-disabled to 403, not a masked 500', async () => {
    const res = await request(app)
      .post('/api/auth/refresh-session')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN_DISABLED}`)
      .set('X-Session-Token', currentSessionToken());

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
    expect(res.body.message).toBe('Account is inactive or has been archived');
  });
});
