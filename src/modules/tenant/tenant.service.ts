import prisma from '../../shared/prisma/prisma.client.js';
import { tenantRepository } from './tenant.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { withEffectiveStatus } from '../event/event-status.util.js';
import { withEffectiveTier } from '../subscription/effective-tier.util.js';
import { type ClientTenantDto } from './tenant.types.js';
import {
  suspendFirebaseAccount,
  reactivateFirebaseAccount,
} from '../../shared/firebase/firebase-account-status.util.js';

// Deliberate, hand-picked projection (ClientTenantDto) — see that
// type's own comment. Every method below that hands a Tenant back to
// tenant.router.ts (and from there, a browser) goes through this;
// tenantRepository.findById itself stays a full, unselected row
// because the subscription-tier-config/*-tier-enforcement.util.ts
// family calls it directly (bypassing this service entirely) and needs
// the full subscription-state columns for resolveEffectiveTier.
const toClientTenant = (tenant: {
  id: string;
  name: string;
  slug: string;
  email: string;
  subscriptionTier: ClientTenantDto['subscriptionTier'];
  subscriptionStatus: ClientTenantDto['subscriptionStatus'];
  createdAt: Date;
}): ClientTenantDto => ({
  id: tenant.id,
  name: tenant.name,
  slug: tenant.slug,
  email: tenant.email,
  subscriptionTier: tenant.subscriptionTier,
  subscriptionStatus: tenant.subscriptionStatus,
  createdAt: tenant.createdAt,
});

export const tenantService = {

  // Routed through withEffectiveTier (Subscription Billing batch), same
  // shape as event.service.ts's withEffectiveStatus — a client-facing
  // tenant read must show the CURRENT effective tier, never the raw
  // stored one, or a lapsed tenant's own frontend (GET /api/tenants/me)
  // would keep offering features it no longer has.
  getAll: async (): Promise<ClientTenantDto[]> =>
    (await tenantRepository.findAll()).map(withEffectiveTier).map(toClientTenant),

  getById: async (id: string, includeArchived = false): Promise<ClientTenantDto> => {
    const tenant = await tenantRepository.findById(id, includeArchived);
    if (!tenant) throw new Error('Tenant not found');
    return toClientTenant(withEffectiveTier(tenant));
  },

  getUsers: async (id: string) => {
    await tenantService.getById(id);
    // Super Admin oversight view — must include suspended users so they
    // remain visible and reactivatable, not just active ones.
    return tenantRepository.findAllUsersByTenant(id, true);
  },

  // Super Admin oversight view — must include archived events so they
  // remain visible and reactivatable, not just active ones (the same
  // bug that shipped three times for user.reactivate/tenant.reactivate/
  // invite.reactivate: archiving hid the record from the only list that
  // could restore it). Routed through withEffectiveStatus like every
  // other event list, so an archived-but-would-otherwise-be-COMPLETED
  // event still reports correctly.
  getEvents: async (id: string) => {
    await tenantService.getById(id);
    const events = await eventRepository.findAll(id, true);
    return events.map(withEffectiveStatus);
  },

  // Locks out the entire tenant and cascades to archiving every
  // User under it. Reversible via reactivate — Super Admin never
  // deletes data.
  suspend: async (id: string, superAdminUserId: string) => {
    await tenantService.getById(id);

    const users = await tenantRepository.findAllUsersByTenant(id);

    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id },
        data: { subscriptionStatus: 'SUSPENDED' },
      });

      for (const user of users) {
        await tx.user.update({
          where: { id: user.id },
          data: { isArchived: true, isActive: false },
        });
      }
    }, {
      // Task 0 (Subscription Billing batch) audit: this loop was one of
      // several prisma.$transaction calls found with NEITHER timeout nor
      // maxWait set — Prisma's defaults (~2s to acquire a connection,
      // ~5s to execute) are tuned for a warm pool and a small, fixed
      // statement count. A tenant's user count is unbounded (every
      // TENANT_ADMIN/EVENT_ADMIN/EVENT_VENDOR under it), making this the
      // same shape of bug bulkCreateWithInvites and rsvp.service.ts's
      // transaction already hit — sequential per-row round trips inside
      // one interactive transaction. Fixed here defensively rather than
      // waiting for a large tenant to hit it in production.
      maxWait: 10000,
      timeout: 15000,
    });

    for (const user of users) {
      await suspendFirebaseAccount(user.firebaseUid);
    }

    return tenantService.getById(id);
  },

  reactivate: async (id: string, superAdminUserId: string) => {
    // includeArchived: true — the whole point of reactivate is to find a
    // tenant that is currently archived and un-archive it. Currently
    // dormant in practice since nothing sets Tenant.isArchived = true yet
    // (tenant suspension uses subscriptionStatus instead), but this must
    // not be left broken for whenever an archive path is added.
    await tenantService.getById(id, true);

    // Per the agreed v1 approach, this uniformly reactivates all
    // users under the tenant, including any that may have been
    // individually suspended before the tenant-wide suspension.
    // A future version could track suspension origin (individual
    // vs cascade) to preserve individual suspensions through a
    // tenant reactivation — out of scope for v1.
    const users = await prisma.user.findMany({
      where: { tenantId: id, isArchived: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id },
        // isArchived is included alongside subscriptionStatus — without it,
        // an archived tenant's lookup would find it (per the fix above) but
        // this mutation would never actually un-archive it.
        data: { subscriptionStatus: 'ACTIVE', isArchived: false },
      });

      for (const user of users) {
        await tx.user.update({
          where: { id: user.id },
          data: { isArchived: false, isActive: true },
        });
      }
    }, {
      // Same reasoning as suspend()'s identical transaction above —
      // Task 0 audit, unbounded per-user loop.
      maxWait: 10000,
      timeout: 15000,
    });

    for (const user of users) {
      await reactivateFirebaseAccount(user.firebaseUid);
    }

    return tenantService.getById(id);
  },
};
