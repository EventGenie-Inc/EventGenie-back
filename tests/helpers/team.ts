import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { type PlatformRole } from '@prisma/client';
import prisma from '../../src/shared/prisma/prisma.client.js';
import { mockVerifyIdToken } from '../setup.js';

// ─────────────────────────────────────────
//  Team Members batch fixtures: signed-in actors for HTTP tests, and a
//  deep cleanup for everything a team test can create in its tenants
//  (events made over HTTP, guests, assignments, invites, accepted users).
//  Hard-deleted, like every fixture: these rows never existed for the
//  product.
// ─────────────────────────────────────────

export interface Actor {
  id: string;
  firebaseUid: string;
  email: string;
  role: PlatformRole;
  tenantId: string | null;
  username: string;
}

export const createTenant = async (name = `Team Tenant ${randomUUID()}`) => {
  const suffix = randomUUID();
  return prisma.tenant.create({
    data: {
      name,
      slug: `team-${suffix}`,
      email: `team-${suffix}@test.invalid`,
      subscriptionTier: 'ELEVATE',
      subscriptionStatus: 'ACTIVE',
      isArchived: false,
    },
  });
};

export const createActor = async (role: PlatformRole, tenantId: string | null): Promise<Actor> => {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      firebaseUid: `team-uid-${suffix}`,
      email: `team-${suffix}@test.invalid`,
      username: `Member ${suffix.slice(0, 8)}`,
      role,
      tenantId,
      isActive: true,
      isArchived: false,
    },
  });
  return { id: user.id, firebaseUid: user.firebaseUid, email: user.email, role: user.role, tenantId: user.tenantId, username: user.username };
};

// Firebase token "uid:<firebaseUid>" resolves to that uid (and the given
// email, for accept tests). Installed per test because setup.ts resets the
// mock before each one.
export const installFirebaseMock = (emails: Record<string, string> = {}) => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('uid:')) throw Object.assign(new Error('bad token'), { code: 'auth/argument-error' });
    const uid = token.slice(4);
    return { uid, ...(emails[uid] ? { email: emails[uid] } : {}) };
  });
};

export const headersFor = (actor: Actor) => {
  const session = jwt.sign(
    { userId: actor.id, firebaseUid: actor.firebaseUid, email: actor.email, role: actor.role, tenantId: actor.tenantId },
    process.env.JWT_SECRET as string,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer uid:${actor.firebaseUid}`, 'X-Session-Token': session };
};

export const createEventWithDay = async (tenantId: string, userId: string, name = `Team Event ${randomUUID()}`) => {
  const event = await prisma.event.create({
    data: { tenantId, createdByUserId: userId, name, status: 'PUBLISHED', createdBy: userId, updatedBy: userId },
  });
  await prisma.memoryHub.create({ data: { eventId: event.id, isPublic: false, createdBy: userId, updatedBy: userId } });
  const day = await prisma.eventDay.create({
    data: {
      eventId: event.id,
      label: 'Day 1',
      date: new Date('2027-03-01'),
      location: 'Test Venue',
      address: '1 Test Road, Cape Town',
      createdBy: userId,
      updatedBy: userId,
    },
  });
  return { event, day };
};

export const assign = (tenantId: string, userId: string, eventId: string, createdBy: string) =>
  prisma.eventAssignment.create({ data: { tenantId, userId, eventId, createdBy } });

// Everything in these tenants, children first.
export const deleteTenantsDeep = async (tenantIds: string[]) => {
  const events = await prisma.event.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  const invites = await prisma.invite.findMany({ where: { eventId: { in: eventIds } }, select: { id: true } });
  const inviteIds = invites.map((i) => i.id);
  const users = await prisma.user.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const userIds = users.map((u) => u.id);

  await prisma.checkIn.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.attendance.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.rsvpResponse.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.ticketPurchase.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.inviteEventDay.deleteMany({ where: { inviteId: { in: inviteIds } } });
  await prisma.invite.deleteMany({ where: { id: { in: inviteIds } } });
  await prisma.guest.updateMany({ where: { eventId: { in: eventIds } }, data: { hostGuestId: null } });
  await prisma.guest.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventAssignment.deleteMany({ where: { OR: [{ tenantId: { in: tenantIds } }, { userId: { in: userIds } }] } });
  await prisma.teamInvite.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.programItem.deleteMany({ where: { program: { eventId: { in: eventIds } } } });
  await prisma.eventProgram.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.rsvpField.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.memoryHub.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventDay.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.eventDraft.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.otpRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
};

export { prisma };
