import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import { inviteDispatchService } from '../../src/modules/invite/invite-dispatch.service.js';
import { emailSendWorker, UNCONFIRMED_SMS } from '../../src/modules/email-send/email-send.worker.js';
import { emailSendService } from '../../src/modules/email-send/email-send.service.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { fakeSms } from '../helpers/fake-sms.js';
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
//  SMSPORTAL DELIVERY REPORTS — POST /api/sms/delivery-reports, signed
//  with SMSPortal's webhook signature (HMAC-SHA256 over
//  "v1:{timestamp}|{METHOD}|{url}|{body}", uppercase hex). A signed report
//  marks the text DELIVERED or FAILED, on the queue item and on the
//  invite (what the organiser sees per guest). An unsigned or wrongly
//  signed one is 401 and changes nothing.
// ─────────────────────────────────────────

const SECRET = Buffer.from('a-test-signing-secret-of-32-bytes!').toString('base64');
const HOST = 'api.e-velope.test';
const PATH = '/api/sms/delivery-reports';

const sign = (body: string, timestamp = Math.floor(Date.now() / 1000), secret = SECRET) => {
  const canonical = `v1:${timestamp}|POST|http://${HOST}${PATH}|${body}`;
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(canonical).digest('hex').toUpperCase();
  return { 'SmsWebhookEngine-Signature': `v1,hmac_sha256=${mac}`, 'SmsWebhookEngine-Timestamp': String(timestamp) };
};

const post = (payload: unknown, headers: Record<string, string> | null = null) => {
  const body = JSON.stringify(payload);
  return request(app)
    .post(PATH)
    .set('Host', HOST)
    .set('Content-Type', 'application/json')
    .set(headers ?? sign(body))
    .send(body);
};

let savedSpark: SubscriptionTierConfig | null = null;
beforeAll(async () => {
  savedSpark = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'SPARK' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'SPARK' },
    create: { tier: 'SPARK', maxEvents: null, maxGuestsPerEvent: null, maxSmsPerMonth: null, maxVendorSpaces: null, smsEnabled: true },
    update: { smsEnabled: true, maxSmsPerMonth: null },
  });
});
afterAll(async () => {
  // Put back what was there; a row this file created goes.
  if (savedSpark) {
    await prisma.subscriptionTierConfig.update({ where: { tier: 'SPARK' }, data: { smsEnabled: savedSpark.smsEnabled, maxSmsPerMonth: savedSpark.maxSmsPerMonth } });
  } else {
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'SPARK' } });
  }
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

// One SMS guest, invited, their text sent by the worker.
const sentText = async (answer?: Parameters<typeof fakeSms.next>[0]) => {
  vi.stubEnv('SMSPORTAL_WEBHOOK_SECRET', SECRET);
  const tenant = await createTestTenant();
  const organiser = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
  const event = await createTestEvent(tenant.id, organiser.id);
  const day = await createTestEventDay(event.id, organiser.id);
  const { guest, invite } = await guestRepository.createWithInvite(event.id, organiser.id, {
    firstName: 'Phone', surname: 'Guest', email: null, phoneNumber: '+27825550401', eventDayIds: [day.id], plusOnesAllowed: 0,
  });
  cleanup.push(
    async () => { await prisma.smsSendLog.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestGuest(guest.id),
    async () => { await prisma.eventDay.deleteMany({ where: { eventId: event.id } }); },
    () => deleteTestEvent(event.id),
    () => deleteTestUserRow(organiser.id),
    () => deleteTestTenant(tenant.id)
  );
  const send = await inviteDispatchService.sendBulk(event.id, [guest.id], organiser.id, 'TENANT_ADMIN', tenant.id);
  fakeSms.next(answer ?? { status: 'ACCEPTED', providerMessageId: '777001', parts: 1, testMode: true });
  await emailSendWorker.runOnce({ eventId: event.id });
  const item = await prisma.emailSendItem.findFirstOrThrow({ where: { inviteId: invite.id } });
  return { tenant, event, invite, item, sendId: send.sendId! };
};

describe('a signed delivery report', () => {
  it('marks the text delivered, on the message and for the guest', async () => {
    const { tenant, event, invite, item, sendId } = await sentText();
    const res = await post({ eventId: 777001, customerId: item.id, phoneNumber: '27825550401', status: 'DELIVRD', sentDataPartsCount: 1 });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual({ received: 1, recorded: 1, ignored: 0 });

    expect(await prisma.emailSendItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ deliveryStatus: 'DELIVERED', deliveryError: null });
    const guestInvite = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(guestInvite.smsStatus).toBe('DELIVERED');
    expect(guestInvite.smsStatusAt).not.toBeNull();

    const progress = await emailSendService.getProgress(event.id, sendId, 'TENANT_ADMIN', tenant.id);
    expect(progress.sms).toEqual({ sent: 1, delivered: 1, undelivered: 0, awaitingReport: 0 });
  }, 60000);

  it('marks it failed with the reason in words; a later FAILED never undoes DELIVERED', async () => {
    const { invite, item } = await sentText();
    // Matched by SMSPortal's eventId alone, PascalCase keys, in a list.
    expect((await post([{ EventId: 777001, Status: 'EXPIRED' }])).status).toBe(200);
    expect(await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).toMatchObject({
      smsStatus: 'FAILED',
      smsStatusReason: expect.stringMatching(/expired/i),
    });
    await post({ customerId: item.id, status: 'DELIVRD' });
    const res = await post({ customerId: item.id, status: 'UNDELIV' });
    expect(res.body.outcome).toEqual({ received: 1, recorded: 0, ignored: 1 });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).smsStatus).toBe('DELIVERED');
  }, 60000);

  it('lists an undelivered text on the send’s progress by name, number and reason, like failures', async () => {
    const { tenant, event, invite, sendId } = await sentText();
    const before = await emailSendService.getProgress(event.id, sendId, 'TENANT_ADMIN', tenant.id);
    expect(before.undeliveredTexts).toEqual([]);

    expect((await post({ eventId: 777001, status: 'UNDELIV' })).status).toBe(200);
    const progress = await emailSendService.getProgress(event.id, sendId, 'TENANT_ADMIN', tenant.id);
    expect(progress.sms).toEqual({ sent: 1, delivered: 0, undelivered: 1, awaitingReport: 0 });
    const reason = (await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).smsStatusReason;
    expect(reason).toBeTruthy();
    expect(progress.undeliveredTexts).toEqual([
      { guestId: invite.guestId, name: 'Phone Guest', contact: '+27825550401', channel: 'SMS', reason },
    ]);
    // Went, so not a failure.
    expect(progress.failures).toEqual([]);
  }, 60000);

  it('confirms a text that ended unconfirmed: SENT after all, its parts counted once', async () => {
    const { invite, item } = await sentText({ status: 'UNKNOWN', reason: 'timeout' });
    expect(item).toMatchObject({ status: 'FAILED', lastError: UNCONFIRMED_SMS });
    expect(await prisma.smsSendLog.count({ where: { inviteId: invite.id } })).toBe(0);

    const report = { eventId: 777002, customerId: item.id, status: 'DELIVRD', sentDataPartsCount: 1 };
    await post(report);
    await post(report); // SMSPortal retrying the same report
    expect(await prisma.emailSendItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: 'SENT', deliveryStatus: 'DELIVERED' });
    expect(await prisma.smsSendLog.count({ where: { inviteId: invite.id } })).toBe(1);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).deliveredAt).not.toBeNull();
  }, 60000);

  it('an in-between status or a message that isn’t ours is answered 200 and ignored', async () => {
    const { invite, item } = await sentText();
    const res = await post([{ customerId: item.id, status: 'SUBMITD' }, { customerId: 'not-ours', status: 'DELIVRD' }]);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual({ received: 2, recorded: 0, ignored: 2 });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).smsStatus).toBe('SENT');
  }, 60000);
});

describe('an unsigned or wrongly signed report', () => {
  it('is 401 and changes nothing', async () => {
    const { invite, item } = await sentText();
    const payload = { customerId: item.id, status: 'DELIVRD' };
    const body = JSON.stringify(payload);

    expect((await post(payload, {})).status).toBe(401);
    expect((await post(payload, sign(body, undefined, Buffer.from('another secret').toString('base64')))).status).toBe(401);
    expect((await post(payload, sign(body, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
    // Signed for one body, sent with another.
    expect((await post({ ...payload, status: 'UNDELIV' }, sign(body))).status).toBe(401);
    vi.stubEnv('SMSPORTAL_WEBHOOK_SECRET', '');
    expect((await post(payload)).status).toBe(401);

    expect((await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } })).smsStatus).toBe('SENT');
  }, 60000);
});
