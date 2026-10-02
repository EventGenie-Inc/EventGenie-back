import { describe, it, expect, afterEach } from 'vitest';
import { vendorService } from '../../src/modules/vendor/vendor.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestVendorSpace,
  deleteTestVendorSpace,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  SECURITY SWEEP BEFORE G3 — FOLLOW-UP 1
//
//  GET /api/vendors/:id (vendorService.getSpaceForViewer): an EVENT_VENDOR
//  reads a space through VendorSpaceUser membership, not tenantId — own
//  space 200 (returns, doesn't throw), foreign space 404. Other roles
//  are unchanged (delegate straight to getSpaceById, unit-tested already
//  in tenant-scope.test.ts).
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

describe('vendorService.getSpaceForViewer — EVENT_VENDOR via membership', () => {
  it('returns the space they are a member of, even a platform-level one with no tenantId', async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    // Platform-level: tenantId null on both the space and the vendor —
    // the exact case getSpaceById (tenant-scoped) can never grant.
    const ownSpace = await createTestVendorSpace(null, ownerUser.id);
    const vendorUser = await createTestUserRow({ role: 'EVENT_VENDOR', tenantId: null });
    await prisma.vendorSpaceUser.create({
      data: { vendorSpaceId: ownSpace.id, userId: vendorUser.id, createdBy: ownerUser.id },
    });
    cleanup.push(
      () => prisma.vendorSpaceUser.deleteMany({ where: { vendorSpaceId: ownSpace.id } }),
      () => deleteTestUserRow(vendorUser.id),
      () => deleteTestVendorSpace(ownSpace.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    const result = await vendorService.getSpaceForViewer(ownSpace.id, vendorUser.role, vendorUser.tenantId, vendorUser.id);
    expect(result.id).toBe(ownSpace.id);
  });

  it("404s for a space they are NOT a member of, even one on their own tenant", async () => {
    const tenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const foreignSpace = await createTestVendorSpace(tenant.id, ownerUser.id);
    // A real, tenant-scoped vendor — same tenant as the space, but never
    // assigned to it via VendorSpaceUser.
    const vendorUser = await createTestUserRow({ role: 'EVENT_VENDOR', tenantId: tenant.id });
    cleanup.push(
      () => deleteTestUserRow(vendorUser.id),
      () => deleteTestVendorSpace(foreignSpace.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(tenant.id)
    );

    await expect(
      vendorService.getSpaceForViewer(foreignSpace.id, vendorUser.role, vendorUser.tenantId, vendorUser.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('TENANT_ADMIN is unchanged — still tenant-scoped, not membership-based', async () => {
    const tenant = await createTestTenant();
    const admin = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const space = await createTestVendorSpace(tenant.id, admin.id);
    cleanup.push(
      () => deleteTestVendorSpace(space.id),
      () => deleteTestUserRow(admin.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await vendorService.getSpaceForViewer(space.id, admin.role, admin.tenantId, admin.id);
    expect(result.id).toBe(space.id);
  });
});
