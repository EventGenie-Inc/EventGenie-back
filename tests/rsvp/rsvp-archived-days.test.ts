import { describe, it, expect, afterEach } from 'vitest';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  ARCHIVED EVENT DAYS AND GUESTS
//
//  Archiving an EventDay only flips its flag; the guest's InviteEventDay
//  row survives. inviteRepository.findByToken used to return it anyway, so
//  a removed day still showed on the invitation and could still be RSVP'd
//  to. Now: validate() lists only live invited days (and does not prefill
//  an answer for an archived one), and submit() refuses an archived day
//  with a 422, writing nothing.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const setup = async () => {
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  const event = await createTestEvent(tenant.id, organiser.id);
  const saturday = await createTestEventDay(event.id, organiser.id, 'Saturday');
  const sunday = await createTestEventDay(event.id, organiser.id, 'Sunday');
  const { guest, invite } = await createTestGuestWithInvite(event.id, organiser.id, [saturday.id, sunday.id]);
  cleanup.push(
    () => deleteTestGuest(guest.id),
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  // The organiser archives Sunday after the invitation went out.
  await prisma.eventDay.update({ where: { id: sunday.id }, data: { isArchived: true } });
  return { invite, saturday, sunday };
};

describe('archived event days — guest side', () => {
  it('validate() lists only live invited days and does not prefill an archived one', async () => {
    const { invite, saturday, sunday } = await setup();
    // An answer given for Sunday before it was archived.
    await prisma.attendance.createMany({
      data: [{ inviteId: invite.id, eventDayId: saturday.id }, { inviteId: invite.id, eventDayId: sunday.id }],
    });

    const result = await rsvpService.validate(invite.token);
    expect(result.invite.inviteEventDay.map((d) => d.eventDay.id)).toEqual([saturday.id]);
    expect(result.attendingDayIds).toEqual([saturday.id]);
  }, 30000);

  it('submit() with an archived day is 422 and writes no attendance; a live day still works', async () => {
    const { invite, saturday, sunday } = await setup();

    const err = await rsvpService
      .submit({ token: invite.token, attending: true, attendingDayIds: [saturday.id, sunday.id] })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(err.message).toMatch(/no longer part of this event/);
    expect(await prisma.attendance.count({ where: { inviteId: invite.id } })).toBe(0);

    const ok = await rsvpService.submit({ token: invite.token, attending: true, attendingDayIds: [saturday.id] });
    expect(ok.attendances.map((a) => a.eventDayId)).toEqual([saturday.id]);
  }, 30000);
});
