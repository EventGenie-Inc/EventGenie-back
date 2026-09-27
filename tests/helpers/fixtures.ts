import { randomUUID } from 'crypto';
import prisma from '../../src/shared/prisma/prisma.client.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';

// ─────────────────────────────────────────
//  Security sweep before G3 — fixtures for the tenant-scoping / RSVP
//  response-shape / email-escaping tests, following tests/helpers/db.ts's
//  own convention: real Postgres rows on DATABASE_URL_TEST, created via
//  the app's OWN repository/Prisma calls (never a hand-rolled duplicate
//  of what create() already does), hard-deleted afterward since these
//  never existed from the product's point of view.
// ─────────────────────────────────────────

export interface FixtureTenant {
  id: string;
}

export const createTestTenant = async (): Promise<FixtureTenant> => {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: {
      name: `Security Sweep Tenant ${suffix}`,
      slug: `security-sweep-${suffix}`,
      email: `security-sweep-${suffix}@test.invalid`,
      subscriptionTier: 'SPARK',
      subscriptionStatus: 'ACTIVE',
      isArchived: false,
    },
  });
  return { id: tenant.id };
};

export const deleteTestTenant = async (tenantId: string): Promise<void> => {
  await prisma.tenant.delete({ where: { id: tenantId } });
};

// A platform user with the given role — tenantId omitted entirely means
// null, exactly like a SUPER_ADMIN-created user that never got one (see
// tenant-scope.util.ts's header comment on how this state arises).
export const createTestUserRow = async (opts: {
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'EVENT_ADMIN' | 'EVENT_VENDOR';
  tenantId?: string | null;
}) => {
  const suffix = randomUUID();
  return prisma.user.create({
    data: {
      firebaseUid: `security-sweep-uid-${suffix}`,
      email: `security-sweep-${suffix}@test.invalid`,
      username: `security-sweep-${suffix}`,
      role: opts.role,
      tenantId: opts.tenantId ?? null,
      isActive: true,
      isArchived: false,
    },
  });
};

export const deleteTestUserRow = async (id: string): Promise<void> => {
  await prisma.user.delete({ where: { id } });
};

// A minimal PUBLISHED, PRIVATE event for the given tenant — bypasses
// eventService.publish()'s organiser-facing validation (ticket rules,
// etc.) by calling the repository directly, same as helpers/db.ts's own
// "fixture, not the full flow" precedent.
export const createTestEvent = async (tenantId: string, userId: string) => {
  const event = await eventRepository.create(tenantId, userId, {
    name: `Security Sweep Event ${randomUUID()}`,
    location: 'Test Venue',
  });
  await eventRepository.updateStatus(event.id, userId, 'PUBLISHED');
  return event;
};

export const deleteTestEvent = async (eventId: string): Promise<void> => {
  await prisma.memoryHub.deleteMany({ where: { eventId } });
  await prisma.event.delete({ where: { id: eventId } });
};

export const createTestEventDay = (eventId: string, userId: string, label = 'Day 1') =>
  prisma.eventDay.create({
    data: {
      eventId,
      label,
      date: new Date('2027-01-01'),
      isArchived: false,
      createdBy: userId,
      updatedBy: userId,
    },
  });

// A guest + invite pair via the app's own createWithInvite — see that
// method's header for why this is one transaction.
export const createTestGuestWithInvite = (eventId: string, userId: string, eventDayIds: string[]) =>
  guestRepository.createWithInvite(eventId, userId, {
    firstName: 'Test',
    surname: 'Guest',
    email: `security-sweep-guest-${randomUUID()}@test.invalid`,
    phoneNumber: null,
    eventDayIds,
    plusOnesAllowed: 0,
  });

export const deleteTestGuest = async (guestId: string): Promise<void> => {
  const invites = await prisma.invite.findMany({ where: { guestId }, select: { id: true } });
  const inviteIds = invites.map((i) => i.id);
  await prisma.attendance.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.rsvpResponse.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.ticketPurchase.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.inviteEventDay.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.invite.deleteMany({ where: { guestId } });
  await prisma.guest.delete({ where: { id: guestId } });
};

export const createTestVendorSpace = (tenantId: string | null, userId: string) =>
  prisma.vendorSpace.create({
    data: {
      name: `Security Sweep Vendor ${randomUUID()}`,
      description: null,
      email: `security-sweep-vendor-${randomUUID()}@test.invalid`,
      phoneNumber: null,
      latitude: 0,
      longitude: 0,
      ...(tenantId !== null && { tenantId }),
      isArchived: false,
      createdBy: userId,
      updatedBy: userId,
    },
  });

export const deleteTestVendorSpace = async (id: string): Promise<void> => {
  await prisma.vendorSpaceUser.deleteMany({ where: { vendorSpaceId: id } });
  await prisma.vendorSpace.delete({ where: { id } });
};

export { prisma };
