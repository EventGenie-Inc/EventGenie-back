import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { mockResendSend } from '../setup.js';
import { eventService } from '../../src/modules/event/event.service.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { userService } from '../../src/modules/user/user.service.js';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import { inviteDispatchService, SMS_UNAVAILABLE_REASON } from '../../src/modules/invite/invite-dispatch.service.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { TICKETING_UNAVAILABLE_MESSAGE } from '../../src/modules/ticket/ticketing-availability.util.js';
import { PUBLIC_EVENTS_UNAVAILABLE_MESSAGE } from '../../src/modules/event/public-events-availability.util.js';
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
//  LAUNCH MODE follow-ups — the paths a switched-off feature must also
//  close, each run with the flag ON (the control) and OFF:
//  - publicEvents: create, update, publish and the wizard can't make an
//    event PUBLIC (422);
//  - vendors: an EVENT_VENDOR user can't be created (422);
//  - ticketing: publish and the wizard's final save refuse a paid event
//    (422, before any plan message), and an RSVP carrying a ticketId is
//    refused;
//  - sms: a resend or reminder to an SMS-only guest is a reported failure,
//    Twilio is never called, and a failed reminder doesn't start the
//    cooldown.
// ─────────────────────────────────────────

const mockTwilioCreate = vi.fn();
vi.mock('twilio', () => ({
  default: () => ({ messages: { create: (...args: unknown[]) => mockTwilioCreate(...args) } }),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  mockTwilioCreate.mockReset();
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const deleteEventDeep = async (eventId: string) => {
  const guests = await prisma.guest.findMany({ where: { eventId }, select: { id: true } });
  const invites = await prisma.invite.findMany({ where: { eventId }, select: { id: true } });
  await prisma.inviteReminderLog.deleteMany({ where: { inviteId: { in: invites.map((i) => i.id) } } });
  for (const g of guests) await deleteTestGuest(g.id);
  const programs = await prisma.eventProgram.findMany({ where: { eventId }, select: { id: true } });
  await prisma.programItem.deleteMany({ where: { programId: { in: programs.map((p) => p.id) } } });
  await prisma.eventProgram.deleteMany({ where: { eventId } });
  await prisma.ticket.deleteMany({ where: { eventId } });
  await prisma.eventDay.deleteMany({ where: { eventId } });
  await deleteTestEvent(eventId);
};

const setup = async () => {
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  cleanup.push(
    async () => {
      const events = await prisma.event.findMany({ where: { tenantId: tenant.id }, select: { id: true } });
      for (const { id } of events) await deleteEventDeep(id);
      await prisma.eventDraft.deleteMany({ where: { createdByUserId: organiser.id } });
      await prisma.user.deleteMany({ where: { tenantId: tenant.id, id: { not: organiser.id } } });
    },
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  // A DRAFT event with one venue'd day — what publish needs.
  const draftEvent = async (data: Record<string, unknown>) => {
    const event = await eventRepository.create(tenant.id, organiser.id, { name: `Follow-up ${randomUUID()}`, ...data });
    await createTestEventDay(event.id, organiser.id);
    return event;
  };
  const publish = (eventId: string) => eventService.publish(eventId, organiser.id, 'TENANT_ADMIN', tenant.id);
  const materialize = async (payload: Record<string, unknown>) => {
    await eventDraftRepository.upsert(tenant.id, organiser.id, {
      currentStep: 4,
      payload: {
        name: `Wizard ${randomUUID()}`,
        days: [{ label: 'Day 1', date: '2030-03-02T00:00:00', location: 'Hall', address: '1 Road' }],
        ...payload,
      },
    });
    return eventDraftService.materialize(tenant.id, organiser.id);
  };
  return { tenant, organiser, draftEvent, publish, materialize };
};

// SPARK, the fixture tenant's plan, allows neither PUBLIC nor PAID, so with
// the flag ON these get the plan's 403. With it OFF they must get the 422
// instead: the flag is checked first, and no upgrade pitch for a feature
// that isn't on offer reaches the tenant.
const planRefusal = { statusCode: 403, message: expect.stringMatching(/plan/) };

describe('publicEvents off — no path makes an event PUBLIC', () => {
  it('create', async () => {
    const { tenant, organiser } = await setup();
    const create = () => eventService.create(tenant.id, organiser.id, { name: `Pub ${randomUUID()}`, visibility: 'PUBLIC' });
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(create()).rejects.toMatchObject(planRefusal);
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    await expect(create()).rejects.toMatchObject({ statusCode: 422, message: PUBLIC_EVENTS_UNAVAILABLE_MESSAGE });
  }, 60000);

  it('update', async () => {
    const { tenant, organiser, draftEvent } = await setup();
    const event = await draftEvent({});
    const update = () => eventService.update(event.id, organiser.id, 'TENANT_ADMIN', tenant.id, { visibility: 'PUBLIC' });
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(update()).rejects.toMatchObject(planRefusal);
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    await expect(update()).rejects.toMatchObject({ statusCode: 422, message: PUBLIC_EVENTS_UNAVAILABLE_MESSAGE });
  }, 60000);

  it('publish an event already saved as PUBLIC', async () => {
    const { draftEvent, publish } = await setup();
    const off = await draftEvent({ visibility: 'PUBLIC' });
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    await expect(publish(off.id)).rejects.toMatchObject({ statusCode: 422, message: PUBLIC_EVENTS_UNAVAILABLE_MESSAGE });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: off.id } })).status).toBe('DRAFT');

    const on = await draftEvent({ visibility: 'PUBLIC' });
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(publish(on.id)).resolves.toMatchObject({ status: 'PUBLISHED' });
  }, 60000);

  it("the wizard's final save", async () => {
    const { materialize } = await setup();
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(materialize({ visibility: 'PUBLIC' })).rejects.toMatchObject(planRefusal);
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    await expect(materialize({ visibility: 'PUBLIC' })).rejects.toMatchObject({ statusCode: 422, message: PUBLIC_EVENTS_UNAVAILABLE_MESSAGE });
  }, 60000);
});

describe('vendors off — creating an EVENT_VENDOR user', () => {
  it('is 422 while off, and works while on', async () => {
    const { tenant, organiser } = await setup();
    const create = () => {
      const suffix = randomUUID();
      return userService.create('TENANT_ADMIN', organiser.id, tenant.id, {
        firebaseUid: `follow-up-${suffix}`, email: `follow-up-${suffix}@test.invalid`, username: `follow-up-${suffix}`, role: 'EVENT_VENDOR',
      });
    };
    vi.stubEnv('FEATURES_DISABLED', 'vendors');
    await expect(create()).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/Vendor accounts aren't available yet/) });

    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(create()).resolves.toMatchObject({ role: 'EVENT_VENDOR' });
  }, 60000);
});

describe('ticketing off — publish, the wizard, and RSVP submit', () => {
  it('publishing an event already saved as PAID is 422 and leaves it a draft', async () => {
    const { draftEvent, publish } = await setup();
    const event = await draftEvent({ ticketing: 'PAID' });
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(publish(event.id)).rejects.toMatchObject(planRefusal);
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    await expect(publish(event.id)).rejects.toMatchObject({ statusCode: 422, message: TICKETING_UNAVAILABLE_MESSAGE });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('DRAFT');
  }, 60000);

  it("the wizard's final save refuses a paid event and creates nothing", async () => {
    const { tenant, materialize } = await setup();
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(materialize({ ticketing: 'PAID' })).rejects.toMatchObject(planRefusal);
    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    await expect(materialize({ ticketing: 'PAID' })).rejects.toMatchObject({ statusCode: 422, message: TICKETING_UNAVAILABLE_MESSAGE });
    expect(await prisma.event.count({ where: { tenantId: tenant.id } })).toBe(0);
  }, 60000);

  it('an RSVP submit carrying a ticketId is refused while off and records nothing', async () => {
    const { tenant, organiser } = await setup();
    const event = await createTestEvent(tenant.id, organiser.id);
    const day = await createTestEventDay(event.id, organiser.id);
    const { invite } = await createTestGuestWithInvite(event.id, organiser.id, [day.id]);
    const submit = () =>
      rsvpService.submit({ token: invite.token, attending: true, attendingDayIds: [day.id], ticketId: 'any-ticket', firstName: 'Test' });

    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    await expect(submit()).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/Tickets aren't available/) });
    const after = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(after.status).toBe('PENDING');
    expect(await prisma.ticketPurchase.count({ where: { inviteId: invite.id } })).toBe(0);

    // On, the same request reaches ticket handling (and is refused there
    // for its own reason: the ticket doesn't exist).
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(submit()).rejects.toMatchObject({ statusCode: 409 });
  }, 60000);
});

describe('sms off — resend and reminders to an SMS-only guest', () => {
  const smsGuest = async () => {
    const { tenant, organiser } = await setup();
    const event = await createTestEvent(tenant.id, organiser.id);
    const day = await createTestEventDay(event.id, organiser.id);
    const { guest, invite } = await guestRepository.createWithInvite(event.id, organiser.id, {
      firstName: 'Phone', surname: 'Only', email: null, phoneNumber: '+27825550199', eventDayIds: [day.id], plusOnesAllowed: 0,
    });
    return { tenant, organiser, event, guest, invite };
  };

  it('resend: a reported failure, nothing sent, nothing logged', async () => {
    const { tenant, event, invite } = await smsGuest();
    vi.stubEnv('FEATURES_DISABLED', 'sms');
    const outcome = await inviteDispatchService.resend(invite.id, 'TENANT_ADMIN', tenant.id);
    expect(outcome).toMatchObject({ ok: false, reason: SMS_UNAVAILABLE_REASON, deliveryMethod: 'SMS' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(await prisma.smsSendLog.count({ where: { eventId: event.id } })).toBe(0);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).deliveredAt).toBeNull();
  }, 60000);

  it('resend, flag on: refused with the plan message instead (the control)', async () => {
    const { tenant, invite } = await smsGuest();
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(inviteDispatchService.resend(invite.id, 'TENANT_ADMIN', tenant.id)).rejects.toMatchObject(planRefusal);
  }, 60000);

  it('reminder: a reported failure, nothing sent, the cooldown not started, the attempt logged', async () => {
    const { tenant, organiser, event, guest, invite } = await smsGuest();
    await prisma.invite.update({ where: { id: invite.id }, data: { deliveredAt: new Date() } });
    mockResendSend.mockClear();

    vi.stubEnv('FEATURES_DISABLED', 'sms');
    const result = await inviteDispatchService.remindBulk(event.id, undefined, organiser.id, 'TENANT_ADMIN', tenant.id);

    expect(result).toMatchObject({ totalSelected: 1, sent: 0, failed: 1, skipped: 0 });
    expect(result.failures).toEqual([{ guestId: guest.id, name: 'Phone Only', contact: '+27825550199', reason: SMS_UNAVAILABLE_REASON }]);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).lastRemindedAt).toBeNull();
    const logs = await prisma.inviteReminderLog.findMany({ where: { inviteId: invite.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ succeeded: false, failureReason: SMS_UNAVAILABLE_REASON });

    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(
      inviteDispatchService.remindBulk(event.id, undefined, organiser.id, 'TENANT_ADMIN', tenant.id)
    ).rejects.toMatchObject(planRefusal);
  }, 60000);
});
