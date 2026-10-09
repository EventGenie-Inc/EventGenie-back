import { randomUUID } from 'crypto';
import { type InviteStatus } from '@prisma/client';
import prisma from '../../src/shared/prisma/prisma.client.js';
import { mockResendSend } from '../setup.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  Announcement fixtures: a tenant with an organiser, a published event
//  with as many days as asked, and guests written row by row so each test
//  can set exactly the state it is about (reply, days, delivered or not,
//  archived, self-registered, a plus-one). Hard-deleted afterwards by
//  deleteTenantsDeep, like every team fixture.
// ─────────────────────────────────────────

const tenantIds: string[] = [];

// Announcements first (deleteTenantsDeep, shared by every team fixture,
// doesn't know about them).
export const cleanupAnnouncementFixtures = async () => {
  if (!tenantIds.length) return;
  const ids = tenantIds.splice(0);
  await prisma.announcementDelivery.deleteMany({ where: { announcement: { event: { tenantId: { in: ids } } } } });
  await prisma.announcement.deleteMany({ where: { event: { tenantId: { in: ids } } } });
  await deleteTenantsDeep(ids);
};

export interface AnnouncementEventFixture {
  tenantId: string;
  organiser: Actor;
  eventId: string;
  dayIds: string[];
}

export const createAnnouncementEvent = async (
  opts: { days?: number; event?: Record<string, unknown> } = {}
): Promise<AnnouncementEventFixture> => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event, day } = await createEventWithDay(tenant.id, organiser.id, `Announcement event ${randomUUID()}`);
  await prisma.event.update({ where: { id: event.id }, data: { hostName: 'Thandi & Sipho', ...(opts.event ?? {}) } });
  const dayIds = [day.id];
  for (let i = 2; i <= (opts.days ?? 1); i++) {
    const extra = await prisma.eventDay.create({
      data: {
        eventId: event.id,
        label: `Day ${i}`,
        date: new Date(`2027-03-0${i}`),
        location: `Venue ${i}`,
        address: `${i} Test Road, Cape Town`,
        createdBy: organiser.id,
        updatedBy: organiser.id,
      },
    });
    dayIds.push(extra.id);
  }
  return { tenantId: tenant.id, organiser, eventId: event.id, dayIds };
};

// A tenant of its own, for cross-tenant tests.
export const createOtherTenant = async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  return tenant;
};

export interface GuestSpec {
  name: string;
  email?: string | null;
  phoneNumber?: string | null;
  status?: InviteStatus;
  // Defaults to every day of the event.
  invitedDayIds?: string[];
  // Defaults to every invited day when ACCEPTED, none otherwise.
  attendingDayIds?: string[];
  // Defaults to true: the invitation reached them.
  delivered?: boolean;
  selfRegistered?: boolean;
  archivedGuest?: boolean;
  archivedInvite?: boolean;
  hostGuestId?: string;
}

export interface FixtureGuest {
  guestId: string;
  inviteId: string;
  token: string;
  email: string | null;
}

export const addGuest = async (fx: AnnouncementEventFixture, spec: GuestSpec): Promise<FixtureGuest> => {
  const status = spec.status ?? 'PENDING';
  const invitedDayIds = spec.invitedDayIds ?? fx.dayIds;
  const attendingDayIds = spec.attendingDayIds ?? (status === 'ACCEPTED' ? invitedDayIds : []);
  const email = spec.email === undefined ? `ann-${randomUUID()}@test.invalid` : spec.email;
  const guest = await prisma.guest.create({
    data: {
      eventId: fx.eventId,
      firstName: spec.name,
      surname: 'Guest',
      email,
      phoneNumber: spec.phoneNumber ?? null,
      isArchived: spec.archivedGuest ?? false,
      hostGuestId: spec.hostGuestId ?? null,
      selfRegisteredAt: spec.selfRegistered ? new Date() : null,
    },
  });
  const token = `ann-token-${randomUUID()}`;
  const invite = await prisma.invite.create({
    data: {
      eventId: fx.eventId,
      guestId: guest.id,
      token,
      status,
      deliveryMethod: email ? 'EMAIL' : 'SMS',
      deliveredAt: spec.delivered === false ? null : new Date(),
      isArchived: spec.archivedInvite ?? false,
      createdBy: fx.organiser.id,
      updatedBy: fx.organiser.id,
    },
  });
  if (invitedDayIds.length) {
    await prisma.inviteEventDay.createMany({ data: invitedDayIds.map((eventDayId) => ({ inviteId: invite.id, eventDayId })) });
  }
  if (attendingDayIds.length) {
    await prisma.attendance.createMany({ data: attendingDayIds.map((eventDayId) => ({ inviteId: invite.id, eventDayId })) });
  }
  return { guestId: guest.id, inviteId: invite.id, token, email };
};

// Every email the suite "sent" (Resend is mocked in tests/setup.ts).
export interface SentEmail {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

export const sentEmails = (): SentEmail[] => mockResendSend.mock.calls.map((call) => call[0] as SentEmail);

export const sentTo = (): string[] => sentEmails().map((e) => e.to).sort();

export { prisma };
