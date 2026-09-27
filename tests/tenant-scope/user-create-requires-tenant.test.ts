import { randomUUID } from 'crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { userService } from '../../src/modules/user/user.service.js';
import { createTestTenant, deleteTestTenant, createTestUserRow, deleteTestUserRow, prisma } from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  SECURITY SWEEP BEFORE G3 — FOLLOW-UP 2
//
//  POST /api/users (userService.create): a TENANT_ADMIN or EVENT_ADMIN
//  created without a tenantId is rejected with 422 — the exact state
//  Fix 1 made getById/getAll fail closed against, now refused at
//  creation instead of merely tolerated afterward. SUPER_ADMIN and
//  EVENT_VENDOR targets are unaffected (see user.service.ts's
//  ROLES_REQUIRING_TENANT comment for why). No existing row is touched —
//  this is a create-time guard only.
// ─────────────────────────────────────────

const newUser = () => ({
  firebaseUid: `follow-up2-uid-${randomUUID()}`,
  email: `follow-up2-${randomUUID()}@test.invalid`,
  username: `follow-up2-${randomUUID()}`,
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

describe('userService.create — tenant requirement at creation', () => {
  it('rejects a SUPER_ADMIN-created TENANT_ADMIN with no tenantId, 422', async () => {
    await expect(
      userService.create('SUPER_ADMIN', 'super-admin-id', null, { ...newUser(), role: 'TENANT_ADMIN' })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a SUPER_ADMIN-created EVENT_ADMIN with no tenantId, 422', async () => {
    await expect(
      userService.create('SUPER_ADMIN', 'super-admin-id', null, { ...newUser(), role: 'EVENT_ADMIN' })
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('allows a SUPER_ADMIN-created EVENT_VENDOR with no tenantId (unaffected)', async () => {
    const dto = { ...newUser(), role: 'EVENT_VENDOR' as const };
    const user = await userService.create('SUPER_ADMIN', 'super-admin-id', null, dto);
    cleanup.push(() => prisma.user.delete({ where: { id: user.id } }));
    expect(user.tenantId).toBeNull();
  });

  it('allows a SUPER_ADMIN-created SUPER_ADMIN with no tenantId (unaffected)', async () => {
    const dto = { ...newUser(), role: 'SUPER_ADMIN' as const };
    const user = await userService.create('SUPER_ADMIN', 'super-admin-id', null, dto);
    cleanup.push(() => prisma.user.delete({ where: { id: user.id } }));
    expect(user.tenantId).toBeNull();
  });

  it('still allows a normal TENANT_ADMIN-created EVENT_ADMIN, forced onto the requester\'s own tenant', async () => {
    const tenant = await createTestTenant();
    const requester = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });

    const dto = { ...newUser(), role: 'EVENT_ADMIN' as const };
    const created = await userService.create('TENANT_ADMIN', requester.id, requester.tenantId, dto);
    // `created` (and requester) must be deleted BEFORE the tenant they
    // reference — pushed first so the FIFO cleanup unwinds in that order.
    cleanup.push(
      () => prisma.user.delete({ where: { id: created.id } }),
      () => deleteTestUserRow(requester.id),
      () => deleteTestTenant(tenant.id)
    );
    expect(created.tenantId).toBe(tenant.id);
  });
});
