import { describe, it, expect, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app, { GENERIC_ERROR_MESSAGE } from '../../src/app.js';
import { mockVerifyIdToken } from '../setup.js';
import { REGISTER_TOKEN_INVALID_MESSAGE } from '../../src/modules/auth/auth.service.js';
import prisma from '../../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  POST /api/auth/register with a Firebase token Firebase refuses (expired,
//  revoked, malformed): a 401 with a message the person can act on. It used
//  to reach the global handler as a 500, because register called
//  verifyIdToken with nothing catching its error. A Firebase failure that
//  ISN'T about the token (an outage) is still a 500: a 401 would tell the
//  person to sign in again for something signing in can't fix.
// ─────────────────────────────────────────

const createdTenantIds: string[] = [];

afterAll(async () => {
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
}, 60000);

const firebaseError = (code: string) => Object.assign(new Error(`Firebase: ${code}`), { code });

const register = () => {
  const suffix = randomUUID().slice(0, 8);
  return request(app)
    .post('/api/auth/register')
    .set('Authorization', 'Bearer some-firebase-token')
    .send({ username: 'New Owner', tenantName: `Register Token ${suffix}`, tenantSlug: `register-token-${suffix}` });
};

describe('POST /api/auth/register — the Firebase token', () => {
  it.each(['auth/id-token-expired', 'auth/id-token-revoked', 'auth/argument-error', 'auth/invalid-id-token'])(
    '%s is a 401 with a clear message, not a 500',
    async (code) => {
      mockVerifyIdToken.mockRejectedValueOnce(firebaseError(code));
      const res = await register();
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ status: 'error', message: REGISTER_TOKEN_INVALID_MESSAGE });
    },
    30000
  );

  it('a Firebase failure that is not about the token stays a 500 (the control: outages are not masked as 401)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockVerifyIdToken.mockRejectedValueOnce(firebaseError('app/network-error'));
    const res = await register();
    vi.restoreAllMocks();
    expect(res.status).toBe(500);
    expect(res.body.message).toBe(GENERIC_ERROR_MESSAGE);
  }, 30000);

  it('a valid token still registers, and the tenant email is stored lowercase and trimmed', async () => {
    const local = `Owner.${randomUUID().slice(0, 8)}`;
    mockVerifyIdToken.mockResolvedValueOnce({ uid: `register-token-${randomUUID()}`, email: ` ${local}@Example.TEST ` });
    const res = await register();
    expect(res.status).toBe(201);
    createdTenantIds.push(res.body.data.tenant.id);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: res.body.data.tenant.id } });
    expect(tenant.email).toBe(`${local.toLowerCase()}@example.test`);
    expect(res.body.data.user.email).toBe(`${local.toLowerCase()}@example.test`);
  }, 60000);
});
