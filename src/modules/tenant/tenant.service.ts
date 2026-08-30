import prisma from '../../shared/prisma/prisma.client.js';
import { tenantRepository } from './tenant.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { withEffectiveStatus } from '../event/event-status.util.js';
import {
  suspendFirebaseAccount,
  reactivateFirebaseAccount,
} from '../../shared/firebase/firebase-account-status.util.js';

export const tenantService = {

  getAll: () => tenantRepository.findAll(),

  getById: async (id: string, includeArchived = false) => {
    const tenant = await tenantRepository.findById(id, includeArchived);
    if (!tenant) throw new Error('Tenant not found');
    return tenant;
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
    });

    for (const user of users) {
      await suspendFirebaseAccount(user.firebaseUid);
    }

    return tenantRepository.findById(id);
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
    });

    for (const user of users) {
      await reactivateFirebaseAccount(user.firebaseUid);
    }

    return tenantRepository.findById(id);
  },
};
