import { randomUUID } from 'crypto';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, type Actor } from '../helpers/team.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import prisma from '../../src/shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  Day capacity fixtures: a tenant with an organiser and one PUBLISHED
//  event whose days are given by label, each with its own capacity (null =
//  no limit) and venue or online. Guests are made through the app's own
//  createWithInvite and accepted through RSVP submit, so they count exactly
//  as a real guest does. Everything is removed with the tenant.
// ─────────────────────────────────────────

const tenantIds: string[] = [];

export const cleanupDayCapacityFixtures = async () => {
  if (tenantIds.length) await deleteTenantsDeep(tenantIds.splice(0));
};

export interface DaySpec {
  label: string;
  capacity?: number | null;
  online?: boolean;
}

export interface CapacityEvent {
  tenantId: string;
  organiser: Actor;
  eventId: string;
  days: Record<string, string>; // label → day id
}

export const createCapacityEvent = async (
  days: DaySpec[],
  event: Record<string, unknown> = {}
): Promise<CapacityEvent> => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  const organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event: created, day: first } = await createEventWithDay(tenant.id, organiser.id, `Capacity event ${randomUUID()}`);
  await prisma.event.update({ where: { id: created.id }, data: { hostName: 'Test Host', ...event } });

  const ids: Record<string, string> = {};
  for (const [i, spec] of days.entries()) {
    const data = {
      label: spec.label,
      date: new Date(Date.UTC(2027, 2, 1 + i)),
      location: spec.online ? null : `Venue ${i + 1}`,
      address: spec.online ? null : `${i + 1} Test Road, Cape Town`,
      locationType: spec.online ? ('ONLINE' as const) : ('VENUE' as const),
      capacity: spec.capacity ?? null,
    };
    const day =
      i === 0
        ? await prisma.eventDay.update({ where: { id: first.id }, data })
        : await prisma.eventDay.create({ data: { ...data, eventId: created.id, createdBy: organiser.id, updatedBy: organiser.id } });
    ids[spec.label] = day.id;
  }
  return { tenantId: tenant.id, organiser, eventId: created.id, days: ids };
};

// An invited guest (PENDING), invited to these days.
export const inviteGuest = async (ev: CapacityEvent, dayIds: string[], plusOnesAllowed = 0) => {
  const { guest, invite } = await guestRepository.createWithInvite(ev.eventId, ev.organiser.id, {
    firstName: 'Guest',
    surname: randomUUID().slice(0, 6),
    email: `cap-${randomUUID()}@test.invalid`,
    phoneNumber: null,
    eventDayIds: dayIds,
    plusOnesAllowed,
  });
  return { guest, invite };
};

// A guest who has accepted these days, with this many plus-ones.
export const acceptedGuest = async (ev: CapacityEvent, dayIds: string[], plusOnes = 0) => {
  const invited = await inviteGuest(ev, dayIds, plusOnes);
  await rsvpService.submit({
    token: invited.invite.token,
    attending: true,
    attendingDayIds: dayIds,
    plusOneNames: Array.from({ length: plusOnes }, (_, i) => `Plus ${i + 1}`),
  });
  return invited;
};

// Attendance rows on a day (every one, whatever the invite's state): what
// "nobody is removed" compares.
export const attendanceRows = (eventDayId: string) => prisma.attendance.count({ where: { eventDayId } });

export { prisma };
