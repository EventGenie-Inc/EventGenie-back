import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockGetUserByEmail, mockGeneratePasswordResetLink } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';
import { issueDeviceToken } from '../../src/modules/auth/device-token.util.js';

// ─────────────────────────────────────────
//  forgotPassword no longer revokes device tokens on REQUEST — Trusted
//  Devices Hardening batch, Part 5. See auth.service.ts's forgotPassword
//  and STEERING.md's revocation paragraph for the argument (anyone who
//  knows an email could trigger it; a completed reset already ends
//  sign-ins via Firebase's own revocation).
// ─────────────────────────────────────────

let user: TestUser;

beforeAll(async () => {
  user = await createTestTenantAndUser();
});

afterAll(async () => {
  await deleteTestTenantAndUser(user);
  await prisma.$disconnect();
});

describe('POST /api/auth/forgot-password', () => {
  it('does NOT revoke the device token when a reset is merely requested', async () => {
    const { token: rawToken } = await issueDeviceToken(user.id);

    mockGetUserByEmail.mockResolvedValueOnce({ uid: user.firebaseUid });
    mockGeneratePasswordResetLink.mockResolvedValueOnce('https://example.test/reset?oobCode=fake');

    const res = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(200);

    const record = await prisma.deviceToken.findFirst({ where: { userId: user.id } });
    expect(record).not.toBeNull();
    expect(record!.revokedAt).toBeNull();
  });

  it('still returns the generic response for an unknown email (no account-existence leak)', async () => {
    mockGetUserByEmail.mockRejectedValueOnce(new Error('no user'));
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@test.invalid' });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/If an account exists/);
  });
});
