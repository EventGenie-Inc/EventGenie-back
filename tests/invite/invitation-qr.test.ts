import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { mockResendSend, mockResendBatchSend } from '../setup.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { sentEmails, type SentEmail } from '../helpers/sent-emails.js';
import { decodeQrDataUrl, inlineQrOf } from '../helpers/qr.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, freshEmail } from '../public-events/helpers.js';
import { buildInviteRsvpLink, INVITE_QR_CAPTION } from '../../src/modules/invite/invite-message.util.js';
import { inviteQrPng } from '../../src/modules/invite/invite-qr.util.js';
import { decodeQrPng } from '../helpers/qr.js';
import { emailSendWorker } from '../../src/modules/email-send/email-send.worker.js';

// ─────────────────────────────────────────
//  INVITATION QR CODES
//
//  Every guest email (invitation, reminder, "You're registered") carries a
//  QR code of that guest's own link, generated on the server and sent as
//  an inline attachment (cid:), never a hosted image. The invitation page
//  gets the same code from POST /api/rsvp/qr, which refuses a removed,
//  pending or declined guest's token exactly as an unknown one, the same
//  404 the page itself gets. Decoded with jsQR: what a phone would open.
// ─────────────────────────────────────────

let tenantId: string;
let organiser: Actor;
let eventId: string;

interface G { guestId: string; inviteId: string; token: string; email: string }
const make = (): G => ({ guestId: randomUUID(), inviteId: randomUUID(), token: `qr-${randomUUID()}`, email: `qr-${randomUUID()}@test.invalid` });
const thandi = make();
const sipho = make();
const removed = make();
const pending = make();
const declined = make();

const qr = (body: object) => request(app).post('/api/rsvp/qr').send(body);
const validate = (token: string) => request(app).get(`/api/rsvp/validate/${encodeURIComponent(token)}`);

const emailTo = (to: string): SentEmail => {
  const found = sentEmails().filter((e) => e.to === to);
  expect(found).toHaveLength(1);
  return found[0]!;
};

// The QR is inline (cid:), carried as an attachment, decodes to exactly
// this guest's link, and the button's link is still there unchanged.
const expectOwnQr = (email: SentEmail, token: string) => {
  const link = buildInviteRsvpLink(token);
  expect(email.html).toContain('src="cid:invite-qr"');
  expect(email.html).toContain(INVITE_QR_CAPTION.replace(/'/g, '&#39;'));
  expect(email.html).toContain(`href="${link}"`);
  expect(email.html).toContain('>Open your e-velope</a>');
  // Never as a hosted image or a data URI: the only img sources are the
  // brand images, a design, and the cid.
  expect(email.html).not.toMatch(/src="data:/);
  expect(email.html).not.toMatch(/<img[^>]+src="[^"]*token=/);
  const inline = inlineQrOf(email);
  expect(inline).not.toBeNull();
  expect(inline!.attachment).toMatchObject({ contentType: 'image/png', contentId: 'invite-qr' });
  expect(inline!.decoded).toBe(link);
  // Well within size limits: Gmail clips HTML past ~102 KB; the image is a
  // few KB.
  expect(Buffer.byteLength(email.html)).toBeLessThan(60_000);
  expect(inline!.attachment.content.length).toBeLessThan(10_000);
  // Nothing to scan in plain text.
  expect(email.text).not.toContain('cid:');
};

beforeAll(async () => {
  tenantId = (await createTenant()).id;
  organiser = await createActor('TENANT_ADMIN', tenantId);
  const { event, day } = await createEventWithDay(tenantId, organiser.id, `QR ${randomUUID()}`);
  eventId = event.id;
  const all = [thandi, sipho, removed, pending, declined];
  await prisma.guest.createMany({
    data: all.map((g, i) => ({
      id: g.guestId, eventId, firstName: `Guest${i}`, email: g.email,
      ...(g === removed ? { isArchived: true } : {}),
      ...(g === pending ? { pendingApproval: true } : {}),
      ...(g === declined ? { registrationDeclinedAt: new Date() } : {}),
    })),
  });
  await prisma.invite.createMany({
    data: all.map((g) => ({
      id: g.inviteId, eventId, guestId: g.guestId, token: g.token, status: 'PENDING' as const,
      deliveryMethod: 'EMAIL' as const, createdBy: organiser.id, updatedBy: organiser.id,
    })),
  });
  await prisma.inviteEventDay.createMany({ data: all.map((g) => ({ inviteId: g.inviteId, eventDayId: day.id })) });
}, 60_000);

afterAll(async () => {
  await prisma.inviteReminderLog.deleteMany({ where: { eventId } });
  await deleteTenantsDeep([tenantId]);
  await cleanupPublicEventFixtures();
}, 60_000);

beforeEach(() => {
  installFirebaseMock();
});

describe('the code itself', () => {
  it("decodes to exactly the guest's own invitation link", async () => {
    expect(decodeQrPng(await inviteQrPng(thandi.token))).toBe(buildInviteRsvpLink(thandi.token));
    expect(decodeQrPng(await inviteQrPng(sipho.token))).toBe(buildInviteRsvpLink(sipho.token));
  });
});

describe('in the emails', () => {
  const post = (path: string, body: object) => request(app).post(`/api/events/${eventId}${path}`).set(headersFor(organiser)).send(body);

  it('the invitation: each guest gets their own code, inline, one email per Resend call', async () => {
    const res = await post('/invites/send', { guestIds: [thandi.guestId, sipho.guestId] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ queued: 2, failed: 0 });
    expect((await emailSendWorker.runOnce({ eventId })).sent).toBe(2);
    expect(mockResendBatchSend).not.toHaveBeenCalled();
    expectOwnQr(emailTo(thandi.email), thandi.token);
    expectOwnQr(emailTo(sipho.email), sipho.token);
  }, 30_000);

  it('a single resend carries it too', async () => {
    // The invitation above went minutes ago; out of the duplicate window now.
    await prisma.emailSendItem.updateMany({ where: { inviteId: thandi.inviteId }, data: { sentAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const res = await post(`/invites/${thandi.inviteId}/resend`, {});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'QUEUED', sendId: expect.any(String) });
    expect((await emailSendWorker.runOnce({ eventId })).sent).toBe(1);
    expectOwnQr(emailTo(thandi.email), thandi.token);
  }, 30_000);

  it('the reminder: each guest gets their own code, inline', async () => {
    await prisma.invite.updateMany({ where: { eventId }, data: { deliveredAt: new Date(), lastRemindedAt: null } });
    const res = await post('/invites/remind', { guestIds: [thandi.guestId, sipho.guestId] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ queued: 2, failed: 0 });
    expect((await emailSendWorker.runOnce({ eventId })).sent).toBe(2);
    expect(mockResendBatchSend).not.toHaveBeenCalled();
    const email = emailTo(thandi.email);
    expect(email.subject).toMatch(/is waiting$/);
    expectOwnQr(email, thandi.token);
    expectOwnQr(emailTo(sipho.email), sipho.token);
  }, 30_000);

  it('"You\'re registered" for a public event: the registrant\'s own code, inline', async () => {
    const ev = await createPublicEvent();
    const address = freshEmail();
    const res = await register(ev.shareToken, { email: address });
    expect(res.status).toBe(201);
    const invite = await prisma.invite.findFirstOrThrow({ where: { eventId: ev.eventId, guest: { email: address } } });
    const email = emailTo(address);
    expect(email.subject).toMatch(/^You're registered for /);
    expectOwnQr(email, invite.token);
    expect(mockResendSend.mock.calls).toHaveLength(1);
  }, 30_000);
});

describe('POST /api/rsvp/qr', () => {
  it("answers the caller's own code, never cached", async () => {
    const res = await qr({ token: thandi.token });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body.data).sort()).toEqual(['height', 'image', 'url', 'width']);
    expect(res.body.data).toMatchObject({ url: buildInviteRsvpLink(thandi.token), width: 320, height: 320 });
    expect(decodeQrDataUrl(res.body.data.image)).toBe(buildInviteRsvpLink(thandi.token));

    const other = await qr({ token: sipho.token });
    expect(decodeQrDataUrl(other.body.data.image)).toBe(buildInviteRsvpLink(sipho.token));
    expect(other.body.data.image).not.toBe(res.body.data.image);
  });

  it('a removed, pending or declined guest, or an unknown token, gets no code: the same 404 the page gets', async () => {
    for (const token of [removed.token, pending.token, declined.token, `qr-unknown-${randomUUID()}`]) {
      const res = await qr({ token });
      const page = await validate(token);
      expect(res.status).toBe(404);
      expect(page.status).toBe(404);
      expect(res.body).toEqual(page.body);
      expect(JSON.stringify(res.body)).not.toContain('image');
    }
  });

  it('no token is a 400; an archived event answers as its page does (410)', async () => {
    expect((await qr({})).status).toBe(400);
    expect((await qr({ token: 42 })).status).toBe(400);

    await prisma.event.update({ where: { id: eventId }, data: { isArchived: true } });
    try {
      const res = await qr({ token: thandi.token });
      const page = await validate(thandi.token);
      expect(res.status).toBe(410);
      expect(res.body).toEqual(page.body);
    } finally {
      await prisma.event.update({ where: { id: eventId }, data: { isArchived: false } });
    }
  });
});
