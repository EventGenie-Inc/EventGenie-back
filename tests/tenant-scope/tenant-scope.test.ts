import { describe, it, expect, afterEach } from 'vitest';
import { eventService } from '../../src/modules/event/event.service.js';
import { userService } from '../../src/modules/user/user.service.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { vendorService } from '../../src/modules/vendor/vendor.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestGuestWithInvite,
  deleteTestGuest,
  createTestVendorSpace,
  deleteTestVendorSpace,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  SECURITY SWEEP BEFORE G3 — FIX 1
//
//  A non-SUPER_ADMIN caller with a null tenantId must fail CLOSED (404
//  from a by-id lookup, an empty array from a list), never fall through
//  to an unscoped, every-tenant query. See tenant-scope.util.ts.
//
//  Each test registers its own cleanup on the shared `cleanup` stack and
//  the top-level afterEach unwinds it in reverse — a backstop that still
//  runs even if an assertion above it throws first.
// ─────────────────────────────────────────

// FIFO, not LIFO — each test pushes cleanup in dependency order
// (children before the parents they reference), so this must unwind in
// the SAME order pushed, not reverse it.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

describe('tenant scope — by-id lookups fail closed for a tenant-less non-SUPER_ADMIN', () => {
  it("eventService.getById: 404, not another tenant's event", async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    const event = await createTestEvent(ownerTenant.id, ownerUser.id);
    const tenantLessUser = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: null });
    cleanup.push(
      () => deleteTestUserRow(tenantLessUser.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    await expect(eventService.getById(event.id, tenantLessUser.role, tenantLessUser.tenantId)).rejects.toMatchObject({
      statusCode: 404,
    });

    // Regression guard: the OWNING tenant can still reach it.
    const found = await eventService.getById(event.id, ownerUser.role, ownerUser.tenantId);
    expect(found.id).toBe(event.id);
  });

  it("userService.getById: 404, not another tenant's user", async () => {
    const ownerTenant = await createTestTenant();
    const target = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: ownerTenant.id });
    const tenantLessUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: null });
    cleanup.push(
      () => deleteTestUserRow(tenantLessUser.id),
      () => deleteTestUserRow(target.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    await expect(userService.getById(target.id, tenantLessUser.role, tenantLessUser.tenantId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("guestService.getById: 404, not another tenant's guest", async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    const event = await createTestEvent(ownerTenant.id, ownerUser.id);
    const { guest } = await createTestGuestWithInvite(event.id, ownerUser.id, []);
    const tenantLessUser = await createTestUserRow({ role: 'EVENT_ADMIN', tenantId: null });
    cleanup.push(
      () => deleteTestUserRow(tenantLessUser.id),
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    await expect(guestService.getById(guest.id, tenantLessUser.role, tenantLessUser.tenantId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("vendorService.getSpaceById: 404 for a tenant-less EVENT_VENDOR — not every tenant's spaces", async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    const space = await createTestVendorSpace(ownerTenant.id, ownerUser.id);
    // The REAL reachable case (see vendor.service.ts's header comment): a
    // platform-level EVENT_VENDOR, tenantId null by design, not a
    // misconfiguration.
    const platformVendor = await createTestUserRow({ role: 'EVENT_VENDOR', tenantId: null });
    cleanup.push(
      () => deleteTestUserRow(platformVendor.id),
      () => deleteTestVendorSpace(space.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    await expect(
      vendorService.getSpaceById(space.id, platformVendor.role, platformVendor.tenantId)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('tenant scope — list lookups fail closed with an empty list', () => {
  it("vendorService.getAllSpaces: empty list for a tenant-less EVENT_VENDOR, not every tenant's spaces", async () => {
    const ownerTenant = await createTestTenant();
    const ownerUser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: ownerTenant.id });
    const space = await createTestVendorSpace(ownerTenant.id, ownerUser.id);
    const platformVendor = await createTestUserRow({ role: 'EVENT_VENDOR', tenantId: null });
    cleanup.push(
      () => deleteTestUserRow(platformVendor.id),
      () => deleteTestVendorSpace(space.id),
      () => deleteTestUserRow(ownerUser.id),
      () => deleteTestTenant(ownerTenant.id)
    );

    const spaces = await vendorService.getAllSpaces(platformVendor.role, platformVendor.tenantId);
    expect(spaces).toEqual([]);
  });
});
