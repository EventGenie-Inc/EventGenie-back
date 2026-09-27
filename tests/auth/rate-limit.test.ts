import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';
import { issueDeviceToken } from '../../src/modules/auth/device-token.util.js';
import { deviceLimiterKey } from '../../src/shared/middleware/rate-limit.middleware.js';

// ─────────────────────────────────────────
//  Rate limiter tests — Trusted Devices Hardening batch, Part 3.
//
//  This file gets its OWN fresh rate-limiter instances: Vitest isolates
//  each test file into its own module registry by default, so
//  rate-limit.middleware.ts's rateLimit(...) calls (and their in-memory
//  counters) are reconstructed fresh here, independent of whatever
//  exchange-session.test.ts's own tests already consumed. No shared
//  budget to reason about across files.
// ─────────────────────────────────────────

let user: TestUser;
const FIREBASE_TOKEN = 'firebase-token-ratelimit';

beforeAll(async () => {
  user = await createTestTenantAndUser();
});

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    if (token === FIREBASE_TOKEN) return { uid: user.firebaseUid };
    const err = new Error('Decoding Firebase ID token failed') as Error & { code: string };
    err.code = 'auth/argument-error';
    throw err;
  });
});

afterAll(async () => {
  await deleteTestTenantAndUser(user);
  await prisma.$disconnect();
});

describe('deviceLimiterKey', () => {
  it('never contains the raw device token — it is the hashed value', () => {
    const raw = 'a'.repeat(64);
    const key = deviceLimiterKey(raw);
    expect(key).not.toContain(raw);
    expect(key).toMatch(/^device:[0-9a-f]{64}$/); // sha256 hex digest, 64 chars
  });

  it('is deterministic — the same raw token always produces the same key', () => {
    const raw = 'b'.repeat(64);
    expect(deviceLimiterKey(raw)).toBe(deviceLimiterKey(raw));
  });

  it('produces different keys for different tokens', () => {
    expect(deviceLimiterKey('c'.repeat(64))).not.toBe(deviceLimiterKey('d'.repeat(64)));
  });
});

describe('exchangeSessionDeviceLimiter — skipSuccessfulRequests', () => {
  it('does not rate-limit repeated SUCCESSFUL exchanges of the same device token', async () => {
    const { token: rawToken } = await issueDeviceToken(user.id);

    // max is 20 — 25 successes must all still succeed if only failures count.
    // 30s: 25 sequential real round trips to the test database, each its
    // own Prisma query, comfortably exceed the 15s global default.
    for (let i = 1; i <= 25; i++) {
      const res = await request(app)
        .post('/api/auth/exchange-session')
        .set('Authorization', `Bearer ${FIREBASE_TOKEN}`)
        .send({ deviceToken: rawToken });
      expect(res.status, `request #${i} should be 200`).toBe(200);
    }
  }, 30000);

  it('DOES rate-limit repeated FAILED exchange attempts for the same device token — 429 after max', async () => {
    // A fixed, never-valid device token value — every attempt is a
    // genuine failure (DEVICE_NOT_RECOGNISED), which is exactly what
    // this limiter is meant to bound.
    const fixedBadToken = 'e'.repeat(64);
    let sawDeviceLimit429 = false;
    let failureCount = 0;

    for (let i = 1; i <= 25; i++) {
      const res = await request(app)
        .post('/api/auth/exchange-session')
        .set('Authorization', `Bearer ${FIREBASE_TOKEN}`)
        .send({ deviceToken: fixedBadToken });

      if (res.status === 429) {
        sawDeviceLimit429 = true;
        expect(res.body.message).toMatch(/for this device/);
        break;
      }
      expect(res.status).toBe(401);
      failureCount++;
    }

    expect(sawDeviceLimit429).toBe(true);
    expect(failureCount).toBeLessThanOrEqual(20); // max
  }, 30000);
});
