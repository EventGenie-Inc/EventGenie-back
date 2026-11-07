import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import request from 'supertest';
import app from '../../src/app.js';
import ExcelJS from 'exceljs';
import { headersFor, installFirebaseMock, createTenant, createActor, createEventWithDay, deleteTenantsDeep } from '../helpers/team.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, view, freshEmail, freshIp, prisma, type PublicEventFixture } from './helpers.js';

// ─────────────────────────────────────────
//  APPROVING PUBLIC REGISTRATIONS (Event.registrationAutoApprove)
//
//  On (the default): registering is exactly as before. Off: a registration
//  is saved awaiting approval, holding its seats, with nothing emailed and
//  no token of the registrant's opening anything until an organiser
//  approves (the invitation email, once) or declines (a short email; the
//  party is archived, which frees the seats).
// ─────────────────────────────────────────

vi.setConfig({ testTimeout: 120_000 });

const ONLINE_URL = 'https://meet.example.test/secret-room-4242';
const PENDING_ANSWER = {
  status: 'ok',
  data: { outcome: 'PENDING_APPROVAL', emailSent: false, message: "You'll get an email once the organiser approves your registration." },
};

const extraTenantIds: string[] = [];

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const events = await prisma.event.findMany({ where: { visibility: 'PUBLIC', name: { startsWith: 'Year-end function' } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  await prisma.announcementDelivery.deleteMany({ where: { announcement: { eventId: { in: eventIds } } } });
  await prisma.announcement.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.storedFile.deleteMany({ where: { eventId: { in: eventIds } } });
  await cleanupPublicEventFixtures();
  if (extraTenantIds.length) await deleteTenantsDeep(extraTenantIds.splice(0));
});

// A public event with approval on (auto-approve off), an online day and,
// when asked, a cap and plus-ones.
const approvalEvent = async (event: Record<string, unknown> = {}): Promise<PublicEventFixture> => {
  const ev = await createPublicEvent({ event: { registrationAutoApprove: false, ...event } });
  await prisma.eventDay.update({ where: { id: ev.dayIds[0]! }, data: { locationType: 'ONLINE', onlineUrl: ONLINE_URL, location: null, address: null } });
  return ev;
};

const registrantOf = async (eventId: string, email: string) => {
  const guest = await prisma.guest.findFirstOrThrow({
    where: { eventId, email },
    include: { invites: true, plusOnes: { include: { invites: true } } },
  });
  return { guest, token: guest.invites[0]!.token };
};

const asOrganiser = (ev: PublicEventFixture) => headersFor(ev.organiser);
const pendingList = (ev: PublicEventFixture) =>
  request(app).get(`/api/events/${ev.eventId}/registrations/pending`).set(asOrganiser(ev));
const approve = (ev: PublicEventFixture, guestId: string) =>
  request(app).post(`/api/events/${ev.eventId}/registrations/${guestId}/approve`).set(asOrganiser(ev));
const decline = (ev: PublicEventFixture, guestId: string) =>
  request(app).post(`/api/events/${ev.eventId}/registrations/${guestId}/decline`).set(asOrganiser(ev));
const restore = (ev: PublicEventFixture, guestId: string) =>
  request(app).post(`/api/guests/${guestId}/reactivate`).set(asOrganiser(ev));
const removeGuest = (ev: PublicEventFixture, guestId: string) => request(app).delete(`/api/guests/${guestId}`).set(asOrganiser(ev));

// Every guest route that takes an invite token answers this token exactly
// as it answers a token that doesn't exist, and nothing carries the event's
// online link.
const expectTokenShut = async (ev: PublicEventFixture, token: string) => {
  const unknown = randomBytes(32).toString('hex');
  const field =
    (await prisma.rsvpField.findFirst({ where: { eventId: ev.eventId, label: 'Proof' } })) ??
    (await prisma.rsvpField.create({
      data: { eventId: ev.eventId, label: 'Proof', fieldType: 'DOCUMENT', isRequired: false, order: 0, createdBy: ev.organiser.id, updatedBy: ev.organiser.id },
    }));

  const routes: [string, (t: string) => request.Test][] = [
    ['GET /api/rsvp/validate', (t) => request(app).get(`/api/rsvp/validate/${t}`)],
    ['POST /api/rsvp/submit', (t) => request(app).post('/api/rsvp/submit').send({ token: t, attending: true, attendingDayIds: ev.dayIds })],
    ['POST /api/rsvp/program', (t) => request(app).post('/api/rsvp/program').send({ token: t })],
    ['POST /api/rsvp/ticket-quote', (t) => request(app).post('/api/rsvp/ticket-quote').send({ token: t, ticketId: 'x', quantity: 1 })],
    ['POST /api/rsvp/ticket-purchase/retry', (t) => request(app).post('/api/rsvp/ticket-purchase/retry').send({ token: t })],
    ['GET /api/rsvp/ticket-purchase/confirm', (t) => request(app).get(`/api/rsvp/ticket-purchase/confirm/${t}`)],
    [
      'POST /api/rsvp/documents',
      (t) => request(app).post('/api/rsvp/documents').field('token', t).field('rsvpFieldId', field.id).attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), 'p.pdf'),
    ],
    ['POST /api/memory-hub/guest-view', (t) => request(app).post('/api/memory-hub/guest-view').send({ token: t })],
    ['POST /api/memory-hub/guest-upload-signature', (t) => request(app).post('/api/memory-hub/guest-upload-signature').send({ token: t, mediaType: 'IMAGE' })],
    [
      'POST /api/memory-hub/guest-items',
      (t) => request(app).post('/api/memory-hub/guest-items').send({ token: t, mediaType: 'IMAGE', mediaUrl: 'https://res.cloudinary.com/x/image/upload/a.jpg', publicId: 'a' }),
    ],
    [
      'POST /api/memory-hub/guest-items/:id/public-sharing',
      (t) => request(app).post('/api/memory-hub/guest-items/some-item/public-sharing').send({ token: t, allowPublicSharing: true }),
    ],
    ['POST /api/storage/files/guest-release', (t) => request(app).post('/api/storage/files/guest-release').send({ token: t, publicId: 'x' })],
  ];

  for (const [name, call] of routes) {
    const shut = await call(token).set('X-Forwarded-For', freshIp());
    const stranger = await call(unknown).set('X-Forwarded-For', freshIp());
    expect({ name, status: shut.status, body: shut.body }).toEqual({ name, status: stranger.status, body: stranger.body });
    expect(shut.status, name).toBeGreaterThanOrEqual(400);
    expect(shut.text, name).not.toContain(ONLINE_URL);
  }

  // Check-in's QR path doesn't know the token either.
  const scan = await request(app).post(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`).set(asOrganiser(ev)).send({ inviteToken: token });
  const scanUnknown = await request(app).post(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`).set(asOrganiser(ev)).send({ inviteToken: unknown });
  expect({ status: scan.status, body: scan.body }).toEqual({ status: scanUnknown.status, body: scanUnknown.body });
};

describe('auto-approve on (the default) behaves exactly as before', () => {
  it('a new event has it on; registering creates a guest not awaiting approval and emails the invitation at once', async () => {
    const ev = await createPublicEvent();
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ev.eventId } })).registrationAutoApprove).toBe(true);

    const email = freshEmail();
    const res = await register(ev.shareToken, { email });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'ok', data: { outcome: 'REGISTERED', emailSent: true, message: 'Check your email for your e-velope.' } });

    const { guest, token } = await registrantOf(ev.eventId, email);
    expect(guest.pendingApproval).toBe(false);
    expect(guest.registrationApprovedAt).toBeNull();
    expect(sentEmails().map((e) => e.to)).toEqual([email]);
    expect(sentEmails()[0]!.html).toContain(`/rsvp?token=${token}`);
    expect((await request(app).get(`/api/rsvp/validate/${token}`)).status).toBe(200);
  });

  it('the settings show autoApprove true and no pending; a non-boolean is refused with its code', async () => {
    const ev = await createPublicEvent();
    const got = await request(app).get(`/api/events/${ev.eventId}/registration-settings`).set(asOrganiser(ev));
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ autoApprove: true, pendingApprovalCount: 0 });

    const bad = await request(app).put(`/api/events/${ev.eventId}/registration-settings`).set(asOrganiser(ev)).send({ autoApprove: 'no' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('REGISTRATION_SETTINGS_AUTO_APPROVE_INVALID');

    const off = await request(app).put(`/api/events/${ev.eventId}/registration-settings`).set(asOrganiser(ev)).send({ autoApprove: false });
    expect(off.status).toBe(200);
    expect(off.body.data.autoApprove).toBe(false);
  });
});

describe('auto-approve off: a registration awaits approval', () => {
  it('is saved (registrant and plus-one marked pending, invite accepted), answers pending, and sends no email at all', async () => {
    const ev = await approvalEvent({ registrationPlusOnesAllowed: 1 });
    const email = freshEmail();
    const res = await register(ev.shareToken, { email, plusOneNames: ['Kabelo'] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(PENDING_ANSWER);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    expect(sentEmails()).toEqual([]);

    const { guest } = await registrantOf(ev.eventId, email);
    expect(guest.pendingApproval).toBe(true);
    expect(guest.selfRegisteredAt).toBeInstanceOf(Date);
    expect(guest.invites[0]).toMatchObject({ status: 'ACCEPTED', deliveredAt: null });
    expect(guest.plusOnes).toHaveLength(1);
    expect(guest.plusOnes[0]!.pendingApproval).toBe(true);

    const settings = await request(app).get(`/api/events/${ev.eventId}/registration-settings`).set(asOrganiser(ev));
    expect(settings.body.data).toMatchObject({ autoApprove: false, pendingApprovalCount: 1, registeredCount: 2 });
  });

  it('registering again with a pending email: the same answer byte for byte, no second guest, nothing sent', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    const first = await register(ev.shareToken, { firstName: 'Original', email });
    const again = await register(ev.shareToken, { firstName: 'Impostor', email: `  ${email.toUpperCase()} ` });
    const stranger = await register(ev.shareToken, { email: freshEmail() });

    expect(again.status).toBe(first.status);
    expect(again.text).toBe(first.text);
    expect(stranger.text).toBe(first.text);
    expect(await prisma.guest.count({ where: { eventId: ev.eventId, email } })).toBe(1);
    expect(sentEmails()).toEqual([]);
  });

  it('a pending registrant’s token opens nothing on any route: each answers exactly as an unknown token, and nothing carries the online link', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    await register(ev.shareToken, { email });
    const { guest, token } = await registrantOf(ev.eventId, email);
    const unknown = randomBytes(32).toString('hex');
    await expectTokenShut(ev, token);

    // Check-in's QR path doesn't know them either, and the door list leaves them out.
    const scan = await request(app)
      .post(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`)
      .set(asOrganiser(ev))
      .send({ inviteToken: token });
    const scanUnknown = await request(app)
      .post(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`)
      .set(asOrganiser(ev))
      .send({ inviteToken: unknown });
    expect({ status: scan.status, body: scan.body }).toEqual({ status: scanUnknown.status, body: scanUnknown.body });
    const byId = await request(app).post(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`).set(asOrganiser(ev)).send({ guestId: guest.id });
    expect(byId.status).toBe(404);
    const roster = await request(app).get(`/api/events/${ev.eventId}/check-in/days/${ev.dayIds[0]}`).set(asOrganiser(ev));
    expect(roster.body.data.guests).toEqual([]);

    // Nothing was written by any of it, and the same token works once approved (the gate is the cause).
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({ pendingApproval: true, isArchived: false });
    expect((await approve(ev, guest.id)).status).toBe(200);
    const opened = await request(app).get(`/api/rsvp/validate/${token}`);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain(ONLINE_URL);
  });

  it('announcements and the cancellation email leave pending registrants out', async () => {
    const ev = await approvalEvent();
    const pendingEmail = freshEmail();
    const approvedEmail = freshEmail();
    await register(ev.shareToken, { email: pendingEmail });
    await register(ev.shareToken, { email: approvedEmail });
    await approve(ev, (await registrantOf(ev.eventId, approvedEmail)).guest.id);
    clearSentEmails();

    const preview = await request(app).post(`/api/events/${ev.eventId}/announcements/preview`).set(asOrganiser(ev)).send({ audience: 'EVERYONE' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.recipientCount).toBe(1);

    const sent = await request(app)
      .post(`/api/events/${ev.eventId}/announcements`)
      .set(asOrganiser(ev))
      .send({ audience: 'EVERYONE', subject: 'Join link', body: `Here it is: ${ONLINE_URL}` });
    expect(sent.status).toBe(201);

    const recipients = sentEmails().map((e) => e.to);
    expect(recipients).toEqual([approvedEmail]);
  });

  it('cancelling emails pending registrants the standard cancellation email without the organiser’s note', async () => {
    const ev = await approvalEvent();
    const pendingEmail = freshEmail();
    const approvedEmail = freshEmail();
    await register(ev.shareToken, { email: pendingEmail });
    await register(ev.shareToken, { email: approvedEmail });
    await approve(ev, (await registrantOf(ev.eventId, approvedEmail)).guest.id);
    const { token } = await registrantOf(ev.eventId, pendingEmail);
    clearSentEmails();

    const note = `Sorry everyone. It was at ${ONLINE_URL}`;
    const cancelled = await request(app).post(`/api/events/${ev.eventId}/cancel`).set(asOrganiser(ev)).send({ note });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.guestNotification).toMatchObject({ sent: 2, failed: 0 });

    const toApproved = sentEmails().find((e) => e.to === approvedEmail)!;
    const toPending = sentEmails().find((e) => e.to === pendingEmail)!;
    expect(sentEmails()).toHaveLength(2);
    expect(toPending.subject).toBe(toApproved.subject);
    expect(toPending.subject).toMatch(/has been cancelled$/);
    expect(toApproved.text).toContain('Sorry everyone.');
    for (const secret of ['Sorry everyone.', ONLINE_URL, token, '/rsvp', 'A note from']) {
      expect(toPending.html).not.toContain(secret);
      expect(toPending.text).not.toContain(secret);
    }
    // Otherwise the standard email: the approved guest's, minus the note.
    expect(toPending.text).toContain('This event has been cancelled');
  });
});

describe('a guest an organiser removed', () => {
  it('can no longer open anything with their token (as an unknown token); restoring them opens it again', async () => {
    const ev = await createPublicEvent();
    await prisma.eventDay.update({ where: { id: ev.dayIds[0]! }, data: { locationType: 'ONLINE', onlineUrl: ONLINE_URL, location: null, address: null } });
    const email = freshEmail();
    await register(ev.shareToken, { email });
    const { guest, token } = await registrantOf(ev.eventId, email);
    expect((await request(app).get(`/api/rsvp/validate/${token}`)).text).toContain(ONLINE_URL);

    expect((await removeGuest(ev, guest.id)).status).toBe(200);
    await expectTokenShut(ev, token);

    expect((await restore(ev, guest.id)).status).toBe(200);
    const opened = await request(app).get(`/api/rsvp/validate/${token}`);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain(ONLINE_URL);
  });

  it('an organiser-added guest on a private event: the same', async () => {
    const tenant = await createTenant();
    extraTenantIds.push(tenant.id);
    const organiser = await createActor('TENANT_ADMIN', tenant.id);
    const { event, day } = await createEventWithDay(tenant.id, organiser.id);
    const added = await request(app)
      .post(`/api/events/${event.id}/guests`)
      .set(headersFor(organiser))
      .send({ firstName: 'Ayanda', email: freshEmail(), eventDayIds: [day.id] });
    expect(added.status).toBe(201);
    const invite = await prisma.invite.findFirstOrThrow({ where: { guestId: added.body.data.id } });

    expect((await request(app).get(`/api/rsvp/validate/${invite.token}`)).status).toBe(200);
    expect((await request(app).delete(`/api/guests/${added.body.data.id}`).set(headersFor(organiser))).status).toBe(200);
    const removed = await request(app).get(`/api/rsvp/validate/${invite.token}`);
    const unknown = await request(app).get(`/api/rsvp/validate/${randomBytes(32).toString('hex')}`);
    expect({ status: removed.status, body: removed.body }).toEqual({ status: unknown.status, body: unknown.body });
    expect((await request(app).post(`/api/guests/${added.body.data.id}/reactivate`).set(headersFor(organiser))).status).toBe(200);
    expect((await request(app).get(`/api/rsvp/validate/${invite.token}`)).status).toBe(200);
  });
});

describe('pending is not accepted', () => {
  it('the event detail counts pending apart from accepted; the export says "Pending approval"', async () => {
    const ev = await approvalEvent({ registrationPlusOnesAllowed: 1 });
    const pendingEmail = freshEmail();
    const approvedEmail = freshEmail();
    await register(ev.shareToken, { firstName: 'Pending', email: pendingEmail, plusOneNames: ['PendingPlus'] });
    await register(ev.shareToken, { firstName: 'Approved', email: approvedEmail });
    await approve(ev, (await registrantOf(ev.eventId, approvedEmail)).guest.id);

    const detail = await request(app).get(`/api/events/${ev.eventId}`).set(asOrganiser(ev));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ acceptedGuestCount: 1, pendingApprovalCount: 1, pendingApprovalGuestCount: 2 });

    const exported = await request(app)
      .get(`/api/events/${ev.eventId}/guests/export`)
      .set(asOrganiser(ev))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.body as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Guests')!;
    const header = sheet.getRow(1).values as unknown[];
    const nameCol = header.indexOf('First Name');
    const statusCol = header.indexOf('Invite Status');
    const statusByName: Record<string, string> = {};
    sheet.eachRow((row, n) => {
      if (n > 1) statusByName[String(row.getCell(nameCol).value)] = String(row.getCell(statusCol).value);
    });
    expect(statusByName).toEqual({ Pending: 'Pending approval', PendingPlus: 'Pending approval', Approved: 'ACCEPTED' });
  });
});

describe('restoring a guest holds to the registration cap', () => {
  it('a removed registrant whose place was taken can’t be restored past the cap, with its own code', async () => {
    const ev = await createPublicEvent({ event: { registrationCap: 2 } });
    const a = freshEmail();
    await register(ev.shareToken, { email: a });
    await register(ev.shareToken, { email: freshEmail() });
    const { guest } = await registrantOf(ev.eventId, a);
    await removeGuest(ev, guest.id);
    expect((await register(ev.shareToken, { email: freshEmail() })).status).toBe(201);

    const res = await restore(ev, guest.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GUEST_RESTORE_OVER_REGISTRATION_CAP');
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).isArchived).toBe(true);
    expect(await prisma.invite.count({ where: { guestId: guest.id, isArchived: false } })).toBe(0);

    // With room again, it restores.
    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationCap: 3 } });
    expect((await restore(ev, guest.id)).status).toBe(200);
  });

  it('a declined party whose seats were taken can’t be restored past the cap; nothing of it comes back', async () => {
    const ev = await approvalEvent({ registrationCap: 2, registrationPlusOnesAllowed: 1 });
    const x = freshEmail();
    await register(ev.shareToken, { email: x, plusOneNames: ['Xplus'] });
    const { guest } = await registrantOf(ev.eventId, x);
    await decline(ev, guest.id);
    expect((await register(ev.shareToken, { email: freshEmail(), plusOneNames: ['Yplus'] })).status).toBe(201);

    const res = await restore(ev, guest.id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GUEST_RESTORE_OVER_REGISTRATION_CAP');
    const party = await prisma.guest.findMany({ where: { OR: [{ id: guest.id }, { hostGuestId: guest.id }] } });
    expect(party).toHaveLength(2);
    for (const g of party) expect(g).toMatchObject({ isArchived: true, pendingApproval: false });
  });
});

describe('restoring a declined registrant brings back the plus-ones that decline archived', () => {
  it('restores them pending with their invites, not a plus-one removed before; approving then covers them', async () => {
    const ev = await approvalEvent({ registrationPlusOnesAllowed: 2 });
    const email = freshEmail();
    await register(ev.shareToken, { email, plusOneNames: ['Kept', 'RemovedEarlier'] });
    const { guest } = await registrantOf(ev.eventId, email);
    const kept = guest.plusOnes.find((p) => p.firstName === 'Kept')!;
    const removedEarlier = guest.plusOnes.find((p) => p.firstName === 'RemovedEarlier')!;
    expect((await removeGuest(ev, removedEarlier.id)).status).toBe(200);

    await decline(ev, guest.id);
    expect((await restore(ev, guest.id)).status).toBe(200);

    expect(await prisma.guest.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ isArchived: false, pendingApproval: true, registrationDeclinedAt: null });
    expect(await prisma.invite.count({ where: { guestId: kept.id, isArchived: false } })).toBe(1);
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: removedEarlier.id } })).toMatchObject({ isArchived: true });

    const listed = (await pendingList(ev)).body.data.registrations;
    expect(listed.map((r: { plusOnes: { firstName: string }[] }) => r.plusOnes.map((p) => p.firstName))).toEqual([['Kept']]);
    expect((await approve(ev, guest.id)).status).toBe(200);
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ pendingApproval: false });
  });
});

describe('the organiser’s pending list', () => {
  it('lists each pending registrant with plus-ones, days, answers and documents, as the guest details do; another tenant gets 404', async () => {
    const ev = await approvalEvent({ registrationPlusOnesAllowed: 1 });
    const club = await prisma.rsvpField.create({
      data: { eventId: ev.eventId, label: 'Club', fieldType: 'TEXT', isRequired: false, order: 0, createdBy: ev.organiser.id, updatedBy: ev.organiser.id },
    });
    const proof = await prisma.rsvpField.create({
      data: { eventId: ev.eventId, label: 'Proof of payment', fieldType: 'DOCUMENT', isRequired: true, order: 1, createdBy: ev.organiser.id, updatedBy: ev.organiser.id },
    });
    const upload = await request(app)
      .post(`/api/public-events/${ev.shareToken}/documents`)
      .set('X-Forwarded-For', '10.210.0.1')
      .field('rsvpFieldId', proof.id)
      .attach('file', Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(100), Buffer.from('\n%%EOF\n')]), 'proof.pdf');
    expect(upload.status).toBe(201);

    const email = freshEmail();
    const reg = await register(ev.shareToken, {
      firstName: 'Lerato',
      email,
      plusOneNames: ['Kabelo'],
      rsvpResponses: [
        { rsvpFieldId: club.id, value: 'Chess' },
        { rsvpFieldId: proof.id, value: upload.body.data.id },
      ],
    });
    expect(reg.body).toEqual(PENDING_ANSWER);
    // An auto-approved guest from before isn't listed.
    await prisma.event.update({ where: { id: ev.eventId }, data: { registrationAutoApprove: true } });
    await register(ev.shareToken, { firstName: 'Earlier', email: freshEmail() });

    const res = await pendingList(ev);
    expect(res.status).toBe(200);
    expect(res.body.data.registrations).toHaveLength(1);
    const [p] = res.body.data.registrations;
    const { guest } = await registrantOf(ev.eventId, email);
    expect(p).toMatchObject({
      guestId: guest.id,
      inviteId: guest.invites[0]!.id,
      firstName: 'Lerato',
      email,
      registeredAt: expect.any(String),
      plusOnes: [{ guestId: guest.plusOnes[0]!.id, firstName: 'Kabelo', surname: null }],
      attendingDays: [{ id: ev.dayIds[0], label: 'Day 1', date: expect.any(String) }],
    });
    const byField = Object.fromEntries(p.answers.map((a: { rsvpField: { label: string } }) => [a.rsvpField.label, a]));
    expect(byField['Club']).toMatchObject({ value: 'Chess', document: null });
    expect(byField['Proof of payment'].document).toMatchObject({ id: upload.body.data.id, fileName: 'proof.pdf', contentType: 'application/pdf' });
    expect(JSON.stringify(p)).not.toMatch(/token|cloudinary|https?:/i);

    // The same answers as the guest details give for that invite.
    const details = await request(app).get(`/api/invites/${guest.invites[0]!.id}/rsvp-responses`).set(asOrganiser(ev));
    expect(p.answers).toEqual(details.body.data);

    const otherTenant = await createTenant();
    extraTenantIds.push(otherTenant.id);
    const stranger = await createActor('TENANT_ADMIN', otherTenant.id);
    const cross = await request(app).get(`/api/events/${ev.eventId}/registrations/pending`).set(headersFor(stranger));
    expect(cross.status).toBe(404);
    const crossApprove = await request(app).post(`/api/events/${ev.eventId}/registrations/${guest.id}/approve`).set(headersFor(stranger));
    expect(crossApprove.status).toBe(404);
    await prisma.user.delete({ where: { id: stranger.id } }).catch(() => undefined);
  });
});

describe('approving', () => {
  it('sends exactly one invitation (as auto-approve would have), clears pending for the party, and a second approve is refused', async () => {
    const ev = await approvalEvent({ registrationPlusOnesAllowed: 1 });
    const email = freshEmail();
    await register(ev.shareToken, { email, plusOneNames: ['Kabelo'] });
    const { guest, token } = await registrantOf(ev.eventId, email);

    const res = await approve(ev, guest.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ guestId: guest.id, decision: 'APPROVED', emailSent: true });

    expect(sentEmails()).toHaveLength(1);
    const [invitation] = sentEmails();
    expect(invitation!.to).toBe(email);
    expect(invitation!.subject).toMatch(/^You're registered for Year-end function /);
    expect(invitation!.html).toContain(`/rsvp?token=${token}`);
    expect(invitation!.text).toContain(ONLINE_URL);

    const after = await registrantOf(ev.eventId, email);
    expect(after.guest).toMatchObject({ pendingApproval: false, registrationDecidedBy: ev.organiser.id, registrationDeclinedAt: null });
    expect(after.guest.registrationApprovedAt).toBeInstanceOf(Date);
    expect(after.guest.plusOnes[0]!.pendingApproval).toBe(false);
    expect(after.guest.invites[0]!.deliveredAt).toBeInstanceOf(Date);

    const again = await approve(ev, guest.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REGISTRATION_ALREADY_APPROVED');
    const declineApproved = await decline(ev, guest.id);
    expect(declineApproved.status).toBe(409);
    expect(declineApproved.body.code).toBe('REGISTRATION_ALREADY_APPROVED');
    expect(sentEmails()).toHaveLength(1);
    expect((await pendingList(ev)).body.data.registrations).toEqual([]);
  });

  it('two approvals racing: exactly one wins and exactly one invitation is sent', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    await register(ev.shareToken, { email });
    const { guest } = await registrantOf(ev.eventId, email);

    const results = await Promise.all([approve(ev, guest.id), approve(ev, guest.id), approve(ev, guest.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'REGISTRATION_ALREADY_APPROVED')).toBe(true);
    expect(sentEmails().filter((e) => e.to === email)).toHaveLength(1);
  });

  it('a guest who isn’t a pending registrant of this event is REGISTRATION_NOT_FOUND', async () => {
    const ev = await approvalEvent({ registrationPlusOnesAllowed: 1 });
    const email = freshEmail();
    await register(ev.shareToken, { email, plusOneNames: ['Kabelo'] });
    const { guest } = await registrantOf(ev.eventId, email);
    const other = await approvalEvent();

    for (const [event, id] of [[ev, guest.plusOnes[0]!.id], [ev, 'no-such-guest'], [other, guest.id]] as const) {
      const res = await approve(event, id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('REGISTRATION_NOT_FOUND');
    }
    expect(sentEmails()).toEqual([]);
  });
});

describe('declining', () => {
  it('frees the place: a full event takes a new registration once the pending party is declined', async () => {
    const ev = await approvalEvent({ registrationCap: 2, registrationPlusOnesAllowed: 1 });
    const email = freshEmail();
    await register(ev.shareToken, { email, plusOneNames: ['Kabelo'] });
    const { guest } = await registrantOf(ev.eventId, email);

    // Pending holds its seats: the event is full.
    const full = await register(ev.shareToken, { email: freshEmail() });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('REGISTRATION_FULL');
    expect((await view(ev.shareToken)).body.data.registration).toMatchObject({ isOpen: false, reason: 'FULL' });

    const res = await decline(ev, guest.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ guestId: guest.id, decision: 'DECLINED', emailSent: true });

    const after = await prisma.guest.findMany({ where: { eventId: ev.eventId }, include: { invites: true } });
    for (const g of after) {
      expect(g).toMatchObject({ isArchived: true, pendingApproval: false });
      expect(g.registrationDeclinedAt).toBeInstanceOf(Date);
      expect(g.invites.every((i) => i.isArchived)).toBe(true);
    }

    expect((await view(ev.shareToken)).body.data.registration).toMatchObject({ isOpen: true });
    const next = await register(ev.shareToken, { email: freshEmail() });
    expect(next.status).toBe(201);
    expect(next.body).toEqual(PENDING_ANSWER);
  });

  it('sends one short email that says nothing about the event beyond its name, and a second decision is refused', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    await register(ev.shareToken, { email });
    const { guest, token } = await registrantOf(ev.eventId, email);

    await decline(ev, guest.id);
    expect(sentEmails()).toHaveLength(1);
    const [sent] = sentEmails();
    expect(sent!.to).toBe(email);
    expect(sent!.subject).toMatch(/^Your registration for Year-end function /);
    expect(sent!.text).toContain('wasn’t accepted');
    for (const secret of [token, ONLINE_URL, '/rsvp', 'Open your e-velope', 'March']) {
      expect(sent!.html).not.toContain(secret);
      expect(sent!.text).not.toContain(secret);
    }

    for (const call of [approve, decline]) {
      const res = await call(ev, guest.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REGISTRATION_ALREADY_DECLINED');
    }
    expect(sentEmails()).toHaveLength(1);
    // Declined is still no way in (an archived guest's token otherwise still opens their invitation).
    expect((await request(app).get(`/api/rsvp/validate/${token}`)).status).toBe(404);
  });

  it('restoring a declined registration makes it pending again; approving it then sends the invitation', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    await register(ev.shareToken, { email });
    const { guest, token } = await registrantOf(ev.eventId, email);
    await decline(ev, guest.id);
    clearSentEmails();

    expect((await request(app).post(`/api/guests/${guest.id}/reactivate`).set(asOrganiser(ev))).status).toBe(200);
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).toMatchObject({
      isArchived: false,
      pendingApproval: true,
      registrationDeclinedAt: null,
    });
    expect((await request(app).get(`/api/rsvp/validate/${token}`)).status).toBe(404);
    expect((await pendingList(ev)).body.data.registrations.map((r: { guestId: string }) => r.guestId)).toEqual([guest.id]);
    expect(sentEmails()).toEqual([]);

    expect((await approve(ev, guest.id)).body.data).toEqual({ guestId: guest.id, decision: 'APPROVED', emailSent: true });
    expect(sentEmails().map((e) => e.subject)).toEqual([expect.stringMatching(/^You're registered for /)]);
    expect((await request(app).get(`/api/rsvp/validate/${token}`)).status).toBe(200);
  });

  it('their documents are kept under the archived-guest rule, not deleted at once', async () => {
    const ev = await approvalEvent();
    const proof = await prisma.rsvpField.create({
      data: { eventId: ev.eventId, label: 'Proof of payment', fieldType: 'DOCUMENT', isRequired: true, order: 0, createdBy: ev.organiser.id, updatedBy: ev.organiser.id },
    });
    const upload = await request(app)
      .post(`/api/public-events/${ev.shareToken}/documents`)
      .set('X-Forwarded-For', '10.211.0.1')
      .field('rsvpFieldId', proof.id)
      .attach('file', Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(100), Buffer.from('\n%%EOF\n')]), 'proof.pdf');
    const email = freshEmail();
    await register(ev.shareToken, { email, rsvpResponses: [{ rsvpFieldId: proof.id, value: upload.body.data.id }] });
    const { guest } = await registrantOf(ev.eventId, email);

    expect((await decline(ev, guest.id)).status).toBe(200);
    const doc = await prisma.guestDocument.findUniqueOrThrow({ where: { id: upload.body.data.id } });
    expect(doc).toMatchObject({ deleteRequestedAt: null, deletedAt: null });
    expect(doc.attachedAt).toBeInstanceOf(Date);
    // Listed with the event's documents, its guest marked removed.
    const docs = await request(app).get(`/api/events/${ev.eventId}/documents`).set(asOrganiser(ev));
    expect(docs.body.data.documents).toEqual([expect.objectContaining({ id: doc.id, guest: expect.objectContaining({ id: guest.id, isArchived: true }) })]);
  });
});

describe('what happens to pending registrations later', () => {
  it('switching auto-approve on approves nobody: they stay pending, and registering again still sends them nothing', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    await register(ev.shareToken, { email });

    const on = await request(app).put(`/api/events/${ev.eventId}/registration-settings`).set(asOrganiser(ev)).send({ autoApprove: true });
    expect(on.body.data).toMatchObject({ autoApprove: true, pendingApprovalCount: 1 });

    const again = await register(ev.shareToken, { email });
    const stranger = await register(ev.shareToken, { email: freshEmail() });
    // The answer a new registration gets now, byte for byte.
    expect(again.text).toBe(stranger.text);
    expect(again.body.data.outcome).toBe('REGISTERED');
    expect(sentEmails().map((e) => e.to)).not.toContain(email);
    expect((await registrantOf(ev.eventId, email)).guest.pendingApproval).toBe(true);
    expect((await pendingList(ev)).body.data.registrations).toHaveLength(1);
  });

  it('once the event has finished they stay pending: approving is refused, declining still works', async () => {
    const ev = await approvalEvent();
    const a = freshEmail();
    const b = freshEmail();
    await register(ev.shareToken, { email: a });
    await register(ev.shareToken, { email: b });
    await prisma.eventDay.update({ where: { id: ev.dayIds[0]! }, data: { date: new Date('2026-01-10') } });

    expect((await pendingList(ev)).body.data.registrations).toHaveLength(2);
    const approved = await approve(ev, (await registrantOf(ev.eventId, a)).guest.id);
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe('REGISTRATION_DECISION_EVENT_FINISHED');
    const declined = await decline(ev, (await registrantOf(ev.eventId, b)).guest.id);
    expect(declined.status).toBe(200);
    expect(sentEmails().map((e) => e.to)).toEqual([b]);
  });

  it('once the event is cancelled neither decision is allowed', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    await register(ev.shareToken, { email });
    await prisma.event.update({ where: { id: ev.eventId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    const { guest } = await registrantOf(ev.eventId, email);
    for (const call of [approve, decline]) {
      const res = await call(ev, guest.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REGISTRATION_DECISION_EVENT_CANCELLED');
    }
    expect(sentEmails()).toEqual([]);
  });

  it('a pending guest an organiser removed must be restored before deciding', async () => {
    const ev = await approvalEvent();
    const email = freshEmail();
    await register(ev.shareToken, { email });
    const { guest } = await registrantOf(ev.eventId, email);
    expect((await request(app).delete(`/api/guests/${guest.id}`).set(asOrganiser(ev))).status).toBe(200);
    const res = await approve(ev, guest.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTRATION_GUEST_REMOVED');
  });
});
