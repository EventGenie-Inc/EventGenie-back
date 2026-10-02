import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';
import { issueDeviceToken, assertDeviceTokenUsable } from '../../src/modules/auth/device-token.util.js';

// ─────────────────────────────────────────
//  DeviceToken.userAgent — Trusted Devices Hardening batch, Part 6.
//  Purely additive column; nothing in enforcement (assertDeviceTokenUsable)
//  reads or depends on it. See prisma/schema.prisma's own comment on the
//  column and the migration's own comment on why it's safe against
//  existing production data.
// ─────────────────────────────────────────

let user: TestUser;

beforeAll(async () => {
  user = await createTestTenantAndUser();
});

afterAll(async () => {
  await deleteTestTenantAndUser(user);
  await prisma.$disconnect();
});

describe('DeviceToken.userAgent', () => {
  it('stores the User-Agent captured at issuance', async () => {
    await issueDeviceToken(user.id, 'Mozilla/5.0 (Test Suite)');
    const record = await prisma.deviceToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    expect(record!.userAgent).toBe('Mozilla/5.0 (Test Suite)');
  });

  it('truncates a User-Agent longer than 512 characters', async () => {
    const longUserAgent = 'X'.repeat(1000);
    await issueDeviceToken(user.id, longUserAgent);
    const record = await prisma.deviceToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    expect(record!.userAgent).toHaveLength(512);
    expect(record!.userAgent).toBe(longUserAgent.slice(0, 512));
  });

  it('defaults to null when no User-Agent is supplied — additive, not required', async () => {
    const { token } = await issueDeviceToken(user.id);
    const record = await prisma.deviceToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    expect(record!.userAgent).toBeNull();

    // Enforcement is unaffected either way — this is the load-bearing
    // claim of "additive": a null userAgent must still be a perfectly
    // usable device token.
    await expect(assertDeviceTokenUsable(token, user.id)).resolves.toBeUndefined();
  });
});
