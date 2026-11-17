import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { type SubscriptionTierConfig } from '@prisma/client';
import { fakeSms } from '../helpers/fake-sms.js';
import { inviteDispatchService } from '../../src/modules/invite/invite-dispatch.service.js';
import { emailSendWorker, EMAIL_SEND_LEASE_MS, UNCONFIRMED_SMS } from '../../src/modules/email-send/email-send.worker.js';
import { emailSendService } from '../../src/modules/email-send/email-send.service.js';
import { smsSendLogRepository } from '../../src/modules/sms-send-log/sms-send-log.repository.js';
import { SMS_NUMBER_MESSAGES } from '../../src/shared/messaging/sms-number.util.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestEventDay,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  SMS THROUGH THE SEND QUEUE — invitations and reminders by text are
//  queued with the emails and sent by the worker (never in the request),
//  through the configured provider (here the fake, tests/helpers/fake-sms.ts):
//  - nothing is texted in the request; the worker sends it, records the
//    parts it cost, marks the invite delivered and its smsStatus SENT;
//  - a retried request texts nobody twice (the queue's duplicate rules);
//  - a text whose provider call may have gone (a worker died mid-call) is
//    never sent again;
//  - a number that can't take a text is refused with a code, nothing queued;
//  - progress counts include texts.
// ─────────────────────────────────────────

let savedSpark: SubscriptionTierConfig | null = null;

beforeAll(async () => {
  // The fixtures' tenants are on SPARK; SMS on it, unlimited, for this file.
  savedSpark = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'SPARK' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'SPARK' },
    create: { tier: 'SPARK', maxEvents: null, maxGuestsPerEvent: null, maxSmsPerMonth: null, maxVendorSpaces: null, smsEnabled: true },
    update: { smsEnabled: true, maxSmsPerMonth: null },
  });
});

// Put back what was there; a row this file created goes (other tests read
// a missing SPARK row as "no SMS").
afterAll(async () => {
  if (savedSpark) {
    await prisma.subscriptionTierConfig.update({
      where: { tier: 'SPARK' },
      data: { smsEnabled: savedSpark.smsEnabled, maxSmsPerMonth: savedSpark.maxSmsPerMonth },
    });
  } else {
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'SPARK' } });
  }
});

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
  await prisma.event.update({ where: { id: event.id }, data: { hostName: 'Thandi' } });
  const day = await createTestEventDay(event.id, organiser.id);
  const guestIds: string[] = [];
  cleanup.push(
    async () => { await prisma.smsSendLog.deleteMany({ where: { eventId: event.id } }); },
    async () => { await prisma.inviteReminderLog.deleteMany({ where: { eventId: event.id } }); },
    async () => { for (const id of guestIds) await deleteTestGuest(id); },
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  const addPhoneGuest = async (phoneNumber: string, firstName = 'Phone') => {
    const { guest, invite } = await guestRepository.createWithInvite(event.id, organiser.id, {
      firstName, surname: 'Guest', email: null, phoneNumber, eventDayIds: [day.id], plusOnesAllowed: 0,
    });
    guestIds.push(guest.id);
    return { guest, invite };
  };
  const send = (ids: string[]) => inviteDispatchService.sendBulk(event.id, ids, organiser.id, 'TENANT_ADMIN', tenant.id);
  const run = () => emailSendWorker.runOnce({ eventId: event.id });
  return { tenant, organiser, event, addPhoneGuest, send, run };
};

describe('an SMS invitation goes through the queue', () => {
  it('is queued (not sent) in the request, then sent by the worker with its parts counted', async () => {
    const { tenant, event, addPhoneGuest, send, run } = await setup();
    const { guest, invite } = await addPhoneGuest('+27825550301');

    const result = await send([guest.id]);
    expect(result).toMatchObject({ totalSelected: 1, queued: 1, sent: 0, failed: 0, skipped: 0 });
    expect(result.sendId).not.toBeNull();
    expect(fakeSms.sent()).toHaveLength(0);

    fakeSms.next({ status: 'ACCEPTED', providerMessageId: '9001', parts: 2, testMode: true });
    expect(await run()).toMatchObject({ sent: 1 });

    const [text] = fakeSms.sent();
    expect(text!.to).toBe('+27825550301');
    // The guest's short link, its code created for this text and kept.
    const { shortCode } = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(shortCode).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(text!.body).toMatch(new RegExp(`^Thandi invites you to Security Sweep Event [^:]*: https?://\\S+/r/${shortCode}$`));
    expect(text!.body).not.toContain('token=');

    const item = await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: invite.id } });
    expect(item).toMatchObject({ channel: 'SMS', status: 'SENT', providerMessageId: '9001', smsParts: 2, deliveryStatus: 'SENT', smsSource: 'QUOTA' });
    expect(text!.reference).toBe(item.id);

    const log = await prisma.smsSendLog.findFirstOrThrow({ where: { inviteId: invite.id } });
    expect(log).toMatchObject({ parts: 2, source: 'QUOTA', emailSendItemId: item.id });
    expect(await smsSendLogRepository.countForTenantThisMonth(tenant.id)).toBe(2);

    const after = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(after.deliveredAt).not.toBeNull();
    expect(after.smsStatus).toBe('SENT');

    const progress = await emailSendService.getProgress(event.id, result.sendId!, 'TENANT_ADMIN', tenant.id);
    expect(progress).toMatchObject({ total: 1, queued: 0, sent: 1, failed: 0, done: true, sms: { sent: 1, delivered: 0, undelivered: 0, awaitingReport: 1 } });
  }, 60000);

  it('a text queued but not yet sent is reserved against the quota', async () => {
    const { tenant, addPhoneGuest, send } = await setup();
    const { guest } = await addPhoneGuest('+27825550302');
    await send([guest.id]);
    expect(await smsSendLogRepository.countForTenantThisMonth(tenant.id)).toBe(1);
  }, 60000);
});

describe('never the same text twice', () => {
  it('a retried request texts nobody twice', async () => {
    const { addPhoneGuest, send, run } = await setup();
    const { guest } = await addPhoneGuest('+27825550303');

    const first = await send([guest.id]);
    // The browser retries before the worker has run: already on its way.
    const retried = await send([guest.id]);
    expect(retried).toMatchObject({ queued: 0, skipped: 1 });
    expect(retried.skippedGuests[0]).toMatchObject({ guestId: guest.id, reason: 'ALREADY_QUEUED', sendId: first.sendId });

    await run();
    // And again after it went: sent minutes ago.
    const again = await send([guest.id]);
    expect(again.skippedGuests[0]).toMatchObject({ reason: 'RECENTLY_SENT' });
    await run();

    expect(fakeSms.sentTo('+27825550303')).toHaveLength(1);
  }, 60000);

  it('a text whose provider call may have gone is never called again after a restart', async () => {
    const { event, addPhoneGuest, send, run } = await setup();
    const { guest, invite } = await addPhoneGuest('+27825550304');
    await send([guest.id]);

    // A worker took it, called SMSPortal and died before recording anything.
    const now = new Date();
    await prisma.emailSendItem.updateMany({
      where: { inviteId: invite.id },
      data: { status: 'SENDING', attempts: 1, providerCallAt: now, leaseUntil: new Date(now.getTime() - 1000) },
    });

    // Its lease has run out: taken again, but not sent again.
    expect(await emailSendWorker.runOnce({ eventId: event.id, now: () => new Date(now.getTime() + EMAIL_SEND_LEASE_MS) })).toMatchObject({ failed: 1, sent: 0 });
    expect(fakeSms.sent()).toHaveLength(0);
    const item = await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: invite.id } });
    expect(item).toMatchObject({ status: 'FAILED', lastError: UNCONFIRMED_SMS });
    expect(await prisma.smsSendLog.count({ where: { inviteId: invite.id } })).toBe(0);
    await run();
    expect(fakeSms.sent()).toHaveLength(0);
  }, 60000);

  it('an unclear answer is not retried; a clear "try later" is, once', async () => {
    const { addPhoneGuest, send, event } = await setup();
    const a = await addPhoneGuest('+27825550305', 'Unclear');
    const b = await addPhoneGuest('+27825550306', 'Later');
    // One at a time, so each gets its own answer (a batch takes them in
    // claim order, which isn't fixed).
    const start = new Date();
    await send([a.guest.id]);
    fakeSms.next({ status: 'UNKNOWN', reason: 'timeout' });
    await emailSendWorker.runOnce({ eventId: event.id });
    await send([b.guest.id]);
    fakeSms.next({ status: 'RETRY', reason: '503' });
    await emailSendWorker.runOnce({ eventId: event.id });
    expect(fakeSms.sent()).toHaveLength(2);
    // Step past the backoff: only the RETRY goes again.
    await emailSendWorker.runOnce({ eventId: event.id, now: () => new Date(start.getTime() + 10 * 60 * 1000) });
    expect(fakeSms.sentTo('+27825550305')).toHaveLength(1);
    expect(fakeSms.sentTo('+27825550306')).toHaveLength(2);
    expect(await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: a.invite.id } })).toMatchObject({ status: 'FAILED', lastError: UNCONFIRMED_SMS });
    expect(await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: b.invite.id } })).toMatchObject({ status: 'SENT' });
  }, 60000);
});

describe('a number that cannot take a text', () => {
  it('is refused with a code, nothing queued or sent; a good number in the same send still goes', async () => {
    const { addPhoneGuest, send, run } = await setup();
    const landline = await addPhoneGuest('+27215550307', 'Landline');
    const abroad = await addPhoneGuest('+447911123456', 'Abroad');
    const mobile = await addPhoneGuest('+27825550308', 'Mobile');

    const result = await send([landline.guest.id, abroad.guest.id, mobile.guest.id]);
    expect(result).toMatchObject({ totalSelected: 3, queued: 1, sent: 0, failed: 2 });
    // In the invites' database order, not the selection's.
    expect(result.failures).toHaveLength(2);
    expect(result.failures).toEqual(expect.arrayContaining([
      { guestId: landline.guest.id, name: 'Landline Guest', contact: '+27215550307', reason: SMS_NUMBER_MESSAGES.SMS_NUMBER_NOT_MOBILE, code: 'SMS_NUMBER_NOT_MOBILE' },
      { guestId: abroad.guest.id, name: 'Abroad Guest', contact: '+447911123456', reason: SMS_NUMBER_MESSAGES.SMS_NUMBER_NOT_SOUTH_AFRICAN, code: 'SMS_NUMBER_NOT_SOUTH_AFRICAN' },
    ]));
    await run();
    expect(fakeSms.sent().map((s) => s.to)).toEqual(['+27825550308']);
    expect(await prisma.emailSendItem.count({ where: { inviteId: { in: [landline.invite.id, abroad.invite.id] } } })).toBe(0);
  }, 60000);

  it('a resend to one is FAILED with its code', async () => {
    const { tenant, organiser, event, addPhoneGuest } = await setup();
    const { invite } = await addPhoneGuest('+27215550309');
    const outcome = await inviteDispatchService.resend(event.id, invite.id, organiser.id, 'TENANT_ADMIN', tenant.id);
    expect(outcome).toMatchObject({ status: 'FAILED', sendId: null, code: 'SMS_NUMBER_NOT_MOBILE' });
  }, 60000);
});

describe('an SMS reminder goes through the queue', () => {
  it('is queued, sent by the worker, logged as SMS, and holds the cooldown', async () => {
    const { tenant, organiser, event, addPhoneGuest, run } = await setup();
    const { guest, invite } = await addPhoneGuest('+27825550310');
    await prisma.invite.update({ where: { id: invite.id }, data: { deliveredAt: new Date() } });
    await prisma.event.update({ where: { id: event.id }, data: { rsvpDeadline: new Date('2099-12-05T00:00:00Z') } });

    const result = await inviteDispatchService.remindBulk(event.id, [guest.id], organiser.id, 'TENANT_ADMIN', tenant.id);
    expect(result).toMatchObject({ totalSelected: 1, queued: 1, sent: 0, failed: 0 });
    expect(fakeSms.sent()).toHaveLength(0);
    await run();

    expect(fakeSms.sent()[0]!.body).toMatch(/^Reminder from Thandi: reply to .* by 5 Dec https?:\/\/\S+$/);
    expect(await prisma.inviteReminderLog.findFirstOrThrow({ where: { inviteId: invite.id } })).toMatchObject({ deliveryMethod: 'SMS', succeeded: true });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).lastRemindedAt).not.toBeNull();
  }, 60000);
});
