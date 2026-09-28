import { describe, it, expect, afterEach } from 'vitest';
import { eventProgramService } from '../../src/modules/event-program/event-program.service.js';
import { programItemService } from '../../src/modules/program-item/program-item.service.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  G3 PREREQUISITES — PART 3
//
//  Contract A: POST /api/rsvp/program (eventProgramService.getProgramForInvite,
//  called from rsvp.router.ts). Guest-facing, token-only, "return flags,
//  don't throw" for every "not available" state — asserted here as the
//  EXACT response shape ({ available: false }, no extra keys), not just
//  "truthy/falsy", since a leaked reason would itself be a STEERING
//  violation.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const deleteTestProgram = async (programId: string): Promise<void> => {
  await prisma.programItem.deleteMany({ where: { programId } });
  await prisma.eventProgram.delete({ where: { id: programId } });
};

const createDay = (eventId: string, userId: string, label: string, date: string) =>
  prisma.eventDay.create({
    data: { eventId, label, date: new Date(date), isArchived: false, createdBy: userId, updatedBy: userId },
  });

describe('POST /api/rsvp/program — eventProgramService.getProgramForInvite (Contract A)', () => {
  it('unknown token: 404, not 500', async () => {
    await expect(eventProgramService.getProgramForInvite('not-a-real-token')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('missing/non-string token: 400', async () => {
    await expect(eventProgramService.getProgramForInvite(undefined)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('cancelled event: { available: false }, no reason given', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const day = await createDay(event.id, user.id, 'Day 1', '2027-06-01');
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, [day.id]);
    await eventRepository.updateStatus(event.id, user.id, 'CANCELLED');

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => prisma.eventDay.delete({ where: { id: day.id } }),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await eventProgramService.getProgramForInvite(invite.token);
    expect(result).toEqual({ available: false });
  });

  it('no program for the event: { available: false }', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const day = await createDay(event.id, user.id, 'Day 1', '2027-06-01');
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, [day.id]);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => prisma.eventDay.delete({ where: { id: day.id } }),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await eventProgramService.getProgramForInvite(invite.token);
    expect(result).toEqual({ available: false });
  });

  it('unpublished program: { available: false }', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const day = await createDay(event.id, user.id, 'Day 1', '2027-06-01');
    const program = await eventProgramService.create(event.id, user.id, user.role, tenant.id, {});
    await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
      title: 'Ceremony',
      startTime: '2027-06-01T14:00:00',
      order: 1,
      eventDayId: day.id,
    });
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, [day.id]);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestProgram(program.id),
      () => prisma.eventDay.delete({ where: { id: day.id } }),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    // program.isPublished is false by construction (repository.create
    // hardcodes it) — never explicitly published here.
    const result = await eventProgramService.getProgramForInvite(invite.token);
    expect(result).toEqual({ available: false });
  });

  it("published, but nothing scheduled on this guest's invited days: { available: false }", async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const invitedDay = await createDay(event.id, user.id, 'Invited Day', '2027-06-01');
    const otherDay = await createDay(event.id, user.id, 'Other Day', '2027-06-02');
    const program = await eventProgramService.create(event.id, user.id, user.role, tenant.id, {});
    await eventProgramService.update(program.id, user.id, user.role, tenant.id, { isPublished: true });
    // Item exists, but only on the day this guest is NOT invited to.
    await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
      title: 'Not this guest',
      startTime: '2027-06-02T14:00:00',
      order: 1,
      eventDayId: otherDay.id,
    });
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, [invitedDay.id]);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestProgram(program.id),
      () => prisma.eventDay.delete({ where: { id: otherDay.id } }),
      () => prisma.eventDay.delete({ where: { id: invitedDay.id } }),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await eventProgramService.getProgramForInvite(invite.token);
    expect(result).toEqual({ available: false });
  }, 30000);

  it(
    'published with items: exact response shape — date-matched null items, unmatched-date fallback, explicit day-scoped items unchanged, sorted, archived excluded, uninvited day excluded',
    async () => {
      const tenant = await createTestTenant();
      const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
      const event = await createTestEvent(tenant.id, user.id);
      const day1 = await createDay(event.id, user.id, 'Ceremony Day', '2027-06-01');
      const day2 = await createDay(event.id, user.id, 'Reception Day', '2027-06-02');
      const day3 = await createDay(event.id, user.id, 'Not Invited Day', '2027-06-03');

      const program = await eventProgramService.create(event.id, user.id, user.role, tenant.id, { title: 'Wedding Weekend' });
      await eventProgramService.update(program.id, user.id, user.role, tenant.id, { isPublished: true });

      // NULL eventDayId, startTime's UTC date equals day1's date — must
      // be matched to day1 ONLY, not shown on day2 too. Deliberately
      // created with the LATEST order value but the EARLIEST startTime
      // on day1, to prove sort is by startTime first, order only as the
      // tiebreaker.
      const itemDateMatchedDay1 = await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
        title: 'Welcome coffee',
        startTime: '2027-06-01T09:00:00',
        order: 5,
      });
      // NULL eventDayId, startTime's UTC date matches NONE of the
      // event's days (a month before the event) — must fall back to
      // every one of the GUEST's invited days (day1 and day2), never
      // day3 (guest isn't invited to it).
      const itemNoDateMatch = await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
        title: 'Bring cash for the bar',
        startTime: '2027-05-15T08:00:00',
        order: 1,
      });
      const itemDay1Late = await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
        title: 'Ceremony',
        startTime: '2027-06-01T15:00:00',
        order: 2,
        eventDayId: day1.id,
      });
      const itemDay1Early = await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
        title: 'Guests arrive',
        description: 'Please be seated',
        startTime: '2027-06-01T14:00:00',
        order: 1,
        eventDayId: day1.id,
      });
      const itemDay2 = await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
        title: 'Reception dinner',
        startTime: '2027-06-02T18:00:00',
        durationMins: 120,
        order: 1,
        eventDayId: day2.id,
      });
      const itemArchived = await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
        title: 'Should not appear',
        startTime: '2027-06-01T10:00:00',
        order: 1,
        eventDayId: day1.id,
      });
      await programItemService.archive(itemArchived.id, event.id, program.id, user.id, user.role, tenant.id);
      // Scheduled on a day this guest is never invited to.
      await programItemService.create(event.id, program.id, user.id, user.role, tenant.id, {
        title: 'Should never leak to this guest',
        startTime: '2027-06-03T10:00:00',
        order: 1,
        eventDayId: day3.id,
      });

      const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, [day1.id, day2.id]);

      cleanup.push(
        () => deleteTestGuest(guest.id),
        () => deleteTestProgram(program.id),
        () => prisma.eventDay.delete({ where: { id: day3.id } }),
        () => prisma.eventDay.delete({ where: { id: day2.id } }),
        () => prisma.eventDay.delete({ where: { id: day1.id } }),
        () => deleteTestEvent(event.id),
        () => deleteTestUserRow(user.id),
        () => deleteTestTenant(tenant.id)
      );

      const result = await eventProgramService.getProgramForInvite(invite.token);

      expect(result).toEqual({
        available: true,
        title: 'Wedding Weekend',
        days: [
          {
            eventDayId: day1.id,
            label: 'Ceremony Day',
            date: day1.date,
            items: [
              { id: itemNoDateMatch.id, title: 'Bring cash for the bar', description: null, startTime: new Date('2027-05-15T08:00:00Z'), durationMins: null },
              { id: itemDateMatchedDay1.id, title: 'Welcome coffee', description: null, startTime: new Date('2027-06-01T09:00:00Z'), durationMins: null },
              { id: itemDay1Early.id, title: 'Guests arrive', description: 'Please be seated', startTime: new Date('2027-06-01T14:00:00Z'), durationMins: null },
              { id: itemDay1Late.id, title: 'Ceremony', description: null, startTime: new Date('2027-06-01T15:00:00Z'), durationMins: null },
            ],
          },
          {
            eventDayId: day2.id,
            label: 'Reception Day',
            date: day2.date,
            items: [
              { id: itemNoDateMatch.id, title: 'Bring cash for the bar', description: null, startTime: new Date('2027-05-15T08:00:00Z'), durationMins: null },
              { id: itemDay2.id, title: 'Reception dinner', description: null, startTime: new Date('2027-06-02T18:00:00Z'), durationMins: 120 },
            ],
          },
        ],
      });
    },
    30000 // heavier fixture (3 days, 7 items, archive, guest+invite) — each round trip to the test database measures ~240ms
  );
});
