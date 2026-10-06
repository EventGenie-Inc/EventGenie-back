import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { mockResendSend } from '../setup.js';
import { rsvpService } from '../../src/modules/rsvp/rsvp.service.js';
import { eventService } from '../../src/modules/event/event.service.js';
import { inviteDispatchService, SMS_UNAVAILABLE_REASON } from '../../src/modules/invite/invite-dispatch.service.js';
import { TICKETING_UNAVAILABLE_MESSAGE } from '../../src/modules/ticket/ticketing-availability.util.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
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
//  LAUNCH MODE — what a switched-off feature means beyond its routes:
//  - invitationDesigns off: /rsvp/validate's design is null even for an
//    event that has one (and the saved design is untouched), and invite
//    emails carry no design image.
//  - ticketing off: validate offers no tickets; a paid event can't be
//    created (422, before any plan message).
//  - sms off: an SMS-only guest is a failure the organiser sees, nothing
//    reaches Twilio, and email guests in the same batch still go out.
//
//  Each case also runs with the flag ON, so the difference is the flag.
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

const DESIGN_URL = 'https://res.cloudinary.com/demo/image/upload/v1/eventgenie/t/invitation-designs/e/launch-mode-design.png';

const setup = async () => {
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  const event = await createTestEvent(tenant.id, organiser.id);
  const day = await createTestEventDay(event.id, organiser.id);
  const { guest, invite } = await createTestGuestWithInvite(event.id, organiser.id, [day.id]);
  const guestIds = [guest.id];
  cleanup.push(
    async () => { for (const id of guestIds) await deleteTestGuest(id); },
    async () => { await prisma.invitationDesign.deleteMany({ where: { eventId: event.id } }); },
    async () => { await prisma.ticket.deleteMany({ where: { eventId: event.id } }); },
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  const addDesign = () =>
    prisma.invitationDesign.create({
      data: {
        eventId: event.id, kind: 'UPLOAD', imageUrl: DESIGN_URL,
        cloudinaryPublicId: 'eventgenie/t/invitation-designs/e/launch-mode-design',
        width: 1080, height: 1350, altText: 'Our card',
        createdBy: organiser.id, updatedBy: organiser.id,
      },
    });
  const addPhoneGuest = async () => {
    const created = await guestRepository.createWithInvite(event.id, organiser.id, {
      firstName: 'Phone', surname: 'Only', email: null, phoneNumber: '+27825550123',
      eventDayIds: [day.id], plusOnesAllowed: 0,
    });
    guestIds.push(created.guest.id);
    return created.guest;
  };
  return { tenant, organiser, event, guest, invite, addDesign, addPhoneGuest };
};

describe('invitationDesigns off — /rsvp/validate', () => {
  it('design is null for an event that has one; the saved design is untouched', async () => {
    const { event, invite, addDesign } = await setup();
    const saved = await addDesign();

    vi.stubEnv('FEATURES_DISABLED', '');
    expect((await rsvpService.validate(invite.token)).design).toMatchObject({ kind: 'UPLOAD', imageUrl: DESIGN_URL });

    vi.stubEnv('FEATURES_DISABLED', 'invitationDesigns');
    expect((await rsvpService.validate(invite.token)).design).toBeNull();

    const stillThere = await prisma.invitationDesign.findFirstOrThrow({ where: { eventId: event.id } });
    expect(stillThere).toEqual(saved);
  }, 60000);
});

describe('invitationDesigns off — invite emails', () => {
  const sentHtml = () => mockResendSend.mock.calls.map((c) => JSON.stringify(c[0])).join('\n');

  it('the email carries the design image only while the feature is on', async () => {
    const { event, organiser, guest, addDesign } = await setup();
    await addDesign();

    vi.stubEnv('FEATURES_DISABLED', '');
    const on = await inviteDispatchService.sendBulk(event.id, [guest.id], 'TENANT_ADMIN', organiser.tenantId);
    expect(on.sent).toBe(1);
    expect(sentHtml()).toContain('launch-mode-design.png');

    mockResendSend.mockClear();
    vi.stubEnv('FEATURES_DISABLED', 'invitationDesigns');
    const off = await inviteDispatchService.sendBulk(event.id, [guest.id], 'TENANT_ADMIN', organiser.tenantId);
    expect(off.sent).toBe(1);
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    expect(sentHtml()).not.toContain('launch-mode-design');
  }, 90000);
});

describe('sms off — invite sending', () => {
  it('flag on: an SMS guest on a plan without SMS is refused with a plan message (the control)', async () => {
    const { event, organiser, addPhoneGuest } = await setup();
    const phoneGuest = await addPhoneGuest();
    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(
      inviteDispatchService.sendBulk(event.id, [phoneGuest.id], 'TENANT_ADMIN', organiser.tenantId)
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/plan/) });
  }, 60000);

  it('flag off: the SMS guest is a visible failure, Twilio is never called, the email guest is sent', async () => {
    const { event, organiser, guest, addPhoneGuest } = await setup();
    const phoneGuest = await addPhoneGuest();
    vi.stubEnv('FEATURES_DISABLED', 'sms');

    const result = await inviteDispatchService.sendBulk(event.id, [guest.id, phoneGuest.id], 'TENANT_ADMIN', organiser.tenantId);

    expect(result).toMatchObject({ totalSelected: 2, sent: 1, failed: 1 });
    expect(result.failures).toEqual([
      { guestId: phoneGuest.id, name: 'Phone Only', contact: '+27825550123', reason: SMS_UNAVAILABLE_REASON },
    ]);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    // Not delivered, so it can be sent again once the guest has an email.
    const smsInvite = await prisma.invite.findFirstOrThrow({ where: { guestId: phoneGuest.id } });
    expect(smsInvite.deliveredAt).toBeNull();
    expect(await prisma.smsSendLog.count({ where: { eventId: event.id } })).toBe(0);
  }, 60000);
});

describe('ticketing off — guests and event creation', () => {
  it('validate offers no tickets for a paid event while ticketing is off', async () => {
    const { event, organiser, invite } = await setup();
    await prisma.event.update({ where: { id: event.id }, data: { ticketing: 'PAID' } });
    await prisma.ticket.create({
      data: { eventId: event.id, name: 'General', price: 150, createdBy: organiser.id, updatedBy: organiser.id },
    });

    vi.stubEnv('FEATURES_DISABLED', '');
    const on = await rsvpService.validate(invite.token);
    expect(on.invite.event.ticketing).toBe('PAID');
    expect(on.invite.event.tickets).toHaveLength(1);

    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    const off = await rsvpService.validate(invite.token);
    expect(off.invite.event.ticketing).toBe('FREE');
    expect(off.invite.event.tickets).toEqual([]);
    expect(off.ticketPurchase).toBeNull();
  }, 60000);

  it('creating a paid event is a 422 while ticketing is off, before any plan message', async () => {
    const { tenant, organiser } = await setup();

    vi.stubEnv('FEATURES_DISABLED', '');
    await expect(
      eventService.create(tenant.id, organiser.id, { name: `Launch Mode ${randomUUID()}`, ticketing: 'PAID' })
    ).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/plan/) });

    vi.stubEnv('FEATURES_DISABLED', 'ticketing');
    await expect(
      eventService.create(tenant.id, organiser.id, { name: `Launch Mode ${randomUUID()}`, ticketing: 'PAID' })
    ).rejects.toMatchObject({ statusCode: 422, message: TICKETING_UNAVAILABLE_MESSAGE });
  }, 60000);
});
