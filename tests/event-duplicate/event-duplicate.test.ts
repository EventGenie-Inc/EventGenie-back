import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { type SubscriptionTier } from '@prisma/client';
import app from '../../src/app.js';
import { createTenant, createActor, installFirebaseMock, headersFor, assign, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { signedUpload } from '../helpers/storage.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { sentEmails, clearSentEmails } from '../helpers/sent-emails.js';
import { fakeSms } from '../helpers/fake-sms.js';
import { subscriptionTierConfigRepository } from '../../src/modules/subscription-tier-config/subscription-tier-config.repository.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';

// ─────────────────────────────────────────
//  DUPLICATING AN EVENT — POST /api/events/:id/duplicate
//
//  The copy is an unpublished draft with the source's setup, every date
//  moved by the same number of days, its own cover and design files, and
//  guests only when asked (never their replies). Invitations, RSVPs,
//  check-ins, media, documents, tickets, passes, reminders, short links,
//  share tokens and feedback stay behind. It counts against the plan's
//  event limit under the creation lock, and is all or nothing.
// ─────────────────────────────────────────

let admin: Actor;
let member: Actor;
let tenantId: string;
const tenantIds: string[] = [];

beforeAll(async () => {
  const tenant = await createTenant();
  tenantId = tenant.id;
  tenantIds.push(tenantId);
  admin = await createActor('TENANT_ADMIN', tenantId);
  member = await createActor('EVENT_ADMIN', tenantId);
}, 60_000);

afterAll(async () => {
  const events = await prisma.event.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  await prisma.reminderSchedule.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.announcement.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventFeedback.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventPass.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.invitationDesign.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.memoryItem.deleteMany({ where: { memoryHub: { eventId: { in: eventIds } } } });
  await prisma.event.updateMany({ where: { id: { in: eventIds } }, data: { coverFileId: null } });
  await prisma.storedFile.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await deleteTenantsDeep(tenantIds);
}, 120_000);

beforeEach(() => {
  installFirebaseMock();
  clearSentEmails();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const shifted = (iso: string, days: number) => new Date(at(iso).getTime() + days * DAY_MS);
// From 2027-03-01 to 2027-06-10.
const SHIFT = 101;
const NEW_FIRST = '2027-06-10';

const duplicate = (eventId: string, body: Record<string, unknown>, actor: Actor = admin) =>
  request(app).post(`/api/events/${eventId}/duplicate`).set(headersFor(actor)).send(body);

const withLimits = (limits: { maxEvents?: number | null; maxGuestsPerEvent?: number | null }) => {
  const real = subscriptionTierConfigRepository.findByTier;
  vi.spyOn(subscriptionTierConfigRepository, 'findByTier').mockImplementation(async (tier: SubscriptionTier) => {
    const config = await real(tier);
    return config ? { ...config, ...limits } : config;
  });
};

const audit = () => ({ createdBy: admin.id, updatedBy: admin.id });

// A two-day event with everything an event can carry, the things that must
// stay behind included.
const buildSource = async (opts: { withFiles?: boolean; visibility?: 'PRIVATE' | 'PUBLIC'; days?: [string, string] } = {}) => {
  const [d1, d2] = opts.days ?? ['2027-03-01', '2027-03-04'];
  const event = await prisma.event.create({
    data: {
      tenantId,
      createdByUserId: admin.id,
      name: `Source ${randomUUID()}`,
      description: 'Fortnightly chess',
      status: 'PUBLISHED',
      visibility: opts.visibility ?? 'PRIVATE',
      hostName: 'The Chess Club',
      capacity: 80,
      rsvpDeadline: new Date(at(`${d1}T23:59:59Z`).getTime() - 4 * DAY_MS),
      shareToken: randomUUID().replace(/-/g, ''),
      registrationEmailDomains: ['club.example'],
      registrationCap: 40,
      registrationClosesAt: new Date(at(`${d1}T23:59:59Z`).getTime() - 6 * DAY_MS),
      registrationPlusOnesAllowed: 1,
      registrationAutoApprove: false,
      ticketsRefundable: true,
      ...audit(),
    },
  });
  const day1 = await prisma.eventDay.create({
    data: {
      eventId: event.id, label: 'Round 1', date: at(d1), startTime: at(`${d1}T14:00:00Z`), endTime: at(`${d1}T22:00:00Z`),
      location: 'Hall', address: '1 Board Road', latitude: -33.9, longitude: 18.4, ...audit(),
    },
  });
  const day2 = await prisma.eventDay.create({
    data: {
      eventId: event.id, label: 'Round 2', date: at(d2), startTime: at(`${d2}T09:00:00Z`), endTime: null,
      locationType: 'ONLINE', onlineUrl: 'https://meet.example/round2', openForRegistration: false, ...audit(),
    },
  });
  const removedDay = await prisma.eventDay.create({
    data: { eventId: event.id, label: 'Cancelled round', date: at(d2), location: 'Hall', address: '1 Board Road', isArchived: true, ...audit() },
  });
  await prisma.rsvpField.createMany({
    data: [
      { eventId: event.id, label: 'Rating band', fieldType: 'DROPDOWN', options: JSON.stringify(['Under 1200', '1200+']), isRequired: true, order: 0, ...audit() },
      { eventId: event.id, label: 'Proof of payment', description: 'Pay R50 first', fieldType: 'DOCUMENT', order: 1, ...audit() },
      { eventId: event.id, label: 'Removed question', fieldType: 'TEXT', order: 2, isArchived: true, ...audit() },
    ],
  });
  const program = await prisma.eventProgram.create({ data: { eventId: event.id, title: 'Schedule', isPublished: false, ...audit() } });
  await prisma.programItem.createMany({
    data: [
      { programId: program.id, eventDayId: day1.id, title: 'Pairings', startTime: at(`${d1}T14:30:00Z`), durationMins: 30, order: 0, ...audit() },
      { programId: program.id, eventDayId: day2.id, title: 'Online blitz', startTime: at(`${d2}T10:00:00Z`), order: 1, ...audit() },
      { programId: program.id, eventDayId: null, title: 'Arbiter briefing', startTime: at(`${d1}T13:00:00Z`), order: 2, ...audit() },
      { programId: program.id, eventDayId: removedDay.id, title: 'On a removed day', startTime: at(`${d2}T10:00:00Z`), order: 3, ...audit() },
    ],
  });
  const hub = await prisma.memoryHub.create({
    data: { eventId: event.id, title: 'Photos', description: 'Share your games', isPublic: true, shareToken: randomUUID().replace(/-/g, ''), opensAt: at(`${d1}T12:00:00Z`), ...audit() },
  });

  // Guests: a plain one (day 1), one on both days with plus-ones, a plus-one,
  // a removed one and one awaiting approval. The first has replied, been
  // texted (short code) and checked in.
  const plain = await prisma.guest.create({ data: { eventId: event.id, firstName: 'Ann', surname: 'Plain', email: `ann-${randomUUID()}@test.invalid`, plusOnesAllowed: 0 } });
  const both = await prisma.guest.create({ data: { eventId: event.id, firstName: 'Bo', phoneNumber: '+27820000001', plusOnesAllowed: 2 } });
  const plusOne = await prisma.guest.create({ data: { eventId: event.id, firstName: 'Plus', hostGuestId: both.id } });
  const removed = await prisma.guest.create({ data: { eventId: event.id, firstName: 'Gone', email: `gone-${randomUUID()}@test.invalid`, isArchived: true } });
  const pending = await prisma.guest.create({ data: { eventId: event.id, firstName: 'Waiting', email: `wait-${randomUUID()}@test.invalid`, pendingApproval: true } });
  const invite = async (guestId: string, dayIds: string[], extra: Record<string, unknown> = {}) => {
    const row = await prisma.invite.create({
      data: { eventId: event.id, guestId, token: randomUUID(), deliveryMethod: 'EMAIL', ...audit(), ...extra },
    });
    await prisma.inviteEventDay.createMany({ data: dayIds.map((eventDayId) => ({ inviteId: row.id, eventDayId })) });
    return row;
  };
  const plainInvite = await invite(plain.id, [day1.id], { status: 'ACCEPTED', deliveredAt: new Date(), shortCode: randomUUID().slice(0, 10) });
  await invite(both.id, [day1.id, day2.id, removedDay.id], { status: 'DECLINED', deliveredAt: new Date() });
  await invite(plusOne.id, [day1.id], { status: 'ACCEPTED' });
  await invite(removed.id, [day1.id]);
  await invite(pending.id, [day1.id]);
  const fields = await prisma.rsvpField.findMany({ where: { eventId: event.id, isArchived: false }, orderBy: { order: 'asc' } });
  await prisma.rsvpResponse.create({ data: { inviteId: plainInvite.id, rsvpFieldId: fields[0]!.id, value: '1200+' } });
  await prisma.attendance.create({ data: { inviteId: plainInvite.id, eventDayId: day1.id } });
  await prisma.checkIn.create({ data: { inviteId: plainInvite.id, eventDayId: day1.id, checkedBy: admin.id } });

  // What must stay behind.
  await prisma.ticket.create({ data: { eventId: event.id, name: 'Entry', price: 50, priceCents: 5000, ...audit() } });
  await prisma.memoryItem.create({
    data: { memoryHubId: hub.id, uploadedByUserId: admin.id, mediaUrl: 'https://res.cloudinary.com/x/image/upload/a.jpg', cloudinaryPublicId: 'a', mediaType: 'IMAGE', bytes: 10, ...audit() },
  });
  await prisma.reminderSchedule.create({ data: { eventId: event.id, sendAt: at(`${d1}T08:00:00Z`), preset: 'CUSTOM', createdBy: admin.id } });
  await prisma.announcement.create({ data: { eventId: event.id, kind: 'ANNOUNCEMENT', subject: 'Hi', audience: 'EVERYONE', sentBy: admin.id, recipientCount: 1, unreachableCount: 0 } });
  await prisma.eventFeedback.create({ data: { eventId: event.id, tenantId, score: 9, submittedBy: admin.id, updatedBy: admin.id } });
  await prisma.eventPass.create({ data: { eventId: event.id, tenantId, passTier: 'SMALL' } });

  let cover: Awaited<ReturnType<typeof signedUpload>> | null = null;
  let design: Awaited<ReturnType<typeof signedUpload>> | null = null;
  if (opts.withFiles !== false) {
    cover = await signedUpload({ kind: 'COVER', tenantId, eventId: event.id, uploadedBy: { userId: admin.id }, bytes: 4321 });
    await prisma.storedFile.update({ where: { id: cover.fileId }, data: { status: 'ATTACHED', bytes: 4321 } });
    await prisma.event.update({ where: { id: event.id }, data: { coverImageUrl: cover.url, coverImagePublicId: cover.publicId, coverFileId: cover.fileId } });
    design = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId, eventId: event.id, uploadedBy: { userId: admin.id }, bytes: 999 });
    await prisma.storedFile.update({ where: { id: design.fileId }, data: { status: 'ATTACHED', bytes: 999 } });
    await prisma.invitationDesign.create({
      data: { eventId: event.id, kind: 'UPLOAD', imageUrl: design.url, cloudinaryPublicId: design.publicId, storedFileId: design.fileId, width: 800, height: 1200, altText: 'A board', ...audit() },
    });
  }
  return { event, day1, day2, removedDay, cover, design, guests: { plain, both, plusOne, removed, pending } };
};

const loadCopy = (id: string) =>
  prisma.event.findUniqueOrThrow({
    where: { id },
    include: {
      eventDays: { orderBy: { date: 'asc' } },
      rsvpFields: { orderBy: { order: 'asc' } },
      program: { include: { programItems: { orderBy: { order: 'asc' } } } },
      memoryHub: { include: { memoryItems: true } },
      invitationDesigns: true,
      tickets: true,
      reminderSchedules: true,
      announcements: true,
      feedback: true,
      eventPass: true,
      guests: { include: { invites: { include: { inviteEventDay: true, rsvpResponses: true, attendances: true, checkIns: true } } } },
      assignments: true,
    },
  });

describe('POST /api/events/:id/duplicate — what is copied', () => {
  it('copies the setup as an unpublished draft, every date moved by the same days, and nothing of item 5', async () => {
    const source = await buildSource();
    const smsBefore = fakeSms.sent().length;
    const res = await duplicate(source.event.id, { name: '  Chess, round two ', firstDate: NEW_FIRST });
    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data.duplication).toEqual({
      sourceEventId: source.event.id,
      shiftDays: SHIFT,
      coverCopied: true,
      designCopied: true,
      coverMissing: false,
      designMissing: false,
      guestsCopied: 0,
      clearedDates: [],
    });

    const copy = await loadCopy(data.id);
    expect(copy.tenantId).toBe(tenantId);
    expect(copy.name).toBe('Chess, round two');
    expect(copy.status).toBe('DRAFT');
    expect(copy.isArchived).toBe(false);
    expect(copy.createdByUserId).toBe(admin.id);
    expect(copy.description).toBe('Fortnightly chess');
    expect(copy.hostName).toBe('The Chess Club');
    expect(copy.capacity).toBe(80);
    expect(copy.ticketsRefundable).toBe(true);
    expect(copy.visibility).toBe('PRIVATE');

    // Days: the first on the new date, the second keeping its 3-day gap,
    // times and the online link kept; the removed day left behind.
    expect(copy.eventDays.map((d) => [d.label, d.date.toISOString().slice(0, 10)])).toEqual([
      ['Round 1', '2027-06-10'],
      ['Round 2', '2027-06-13'],
    ]);
    const [c1, c2] = copy.eventDays;
    expect(c1!.startTime).toEqual(shifted('2027-03-01T14:00:00Z', SHIFT));
    expect(c1!.endTime).toEqual(shifted('2027-03-01T22:00:00Z', SHIFT));
    expect([c1!.location, c1!.address, Number(c1!.latitude), Number(c1!.longitude)]).toEqual(['Hall', '1 Board Road', -33.9, 18.4]);
    expect(c2!.locationType).toBe('ONLINE');
    expect(c2!.onlineUrl).toBe('https://meet.example/round2');
    expect(c2!.openForRegistration).toBe(false);
    expect(c2!.startTime).toEqual(shifted('2027-03-04T09:00:00Z', SHIFT));

    // Registration settings and deadlines, shifted.
    expect(copy.rsvpDeadline).toEqual(shifted(source.event.rsvpDeadline!.toISOString(), SHIFT));
    expect(copy.registrationClosesAt).toEqual(shifted(source.event.registrationClosesAt!.toISOString(), SHIFT));
    expect(copy.registrationEmailDomains).toEqual(['club.example']);
    expect(copy.registrationCap).toBe(40);
    expect(copy.registrationPlusOnesAllowed).toBe(1);
    expect(copy.registrationAutoApprove).toBe(false);

    // Questions with every setting; the removed one left behind.
    expect(copy.rsvpFields.map((f) => [f.label, f.fieldType, f.options, f.description, f.isRequired, f.order])).toEqual([
      ['Rating band', 'DROPDOWN', JSON.stringify(['Under 1200', '1200+']), null, true, 0],
      ['Proof of payment', 'DOCUMENT', null, 'Pay R50 first', false, 1],
    ]);

    // The program: items on the copy's days, shifted; the removed day's item left behind.
    expect(copy.program!.title).toBe('Schedule');
    expect(copy.program!.isPublished).toBe(false);
    expect(copy.program!.programItems.map((i) => [i.title, i.eventDayId, i.startTime.toISOString(), i.durationMins])).toEqual([
      ['Pairings', c1!.id, shifted('2027-03-01T14:30:00Z', SHIFT).toISOString(), 30],
      ['Online blitz', c2!.id, shifted('2027-03-04T10:00:00Z', SHIFT).toISOString(), null],
      ['Arbiter briefing', null, shifted('2027-03-01T13:00:00Z', SHIFT).toISOString(), null],
    ]);

    // Memory Hub settings, with its own share link; no photos.
    const sourceHub = await prisma.memoryHub.findUniqueOrThrow({ where: { eventId: source.event.id } });
    expect(copy.memoryHub!.title).toBe('Photos');
    expect(copy.memoryHub!.description).toBe('Share your games');
    expect(copy.memoryHub!.isPublic).toBe(true);
    expect(copy.memoryHub!.shareToken).toMatch(/^[0-9a-f]{64}$/);
    expect(copy.memoryHub!.shareToken).not.toBe(sourceHub.shareToken);
    expect(copy.memoryHub!.opensAt).toEqual(shifted('2027-03-01T12:00:00Z', SHIFT));
    expect(copy.memoryHub!.memoryItems).toEqual([]);

    // Never copied.
    expect(copy.shareToken).toBeNull();
    expect(copy.guests).toEqual([]);
    expect(copy.tickets).toEqual([]);
    expect(copy.reminderSchedules).toEqual([]);
    expect(copy.announcements).toEqual([]);
    expect(copy.feedback).toBeNull();
    expect(copy.eventPass).toBeNull();
    expect(copy.cancelledAt).toBeNull();
    expect(await prisma.invite.count({ where: { eventId: copy.id } })).toBe(0);
    expect(await prisma.guestDocument.count({ where: { eventId: copy.id } })).toBe(0);
    expect(sentEmails()).toEqual([]);
    expect(fakeSms.sent().length).toBe(smsBefore);

    // A TENANT_ADMIN is never locked, so isn't assigned.
    expect(copy.assignments).toEqual([]);
    // The source is untouched.
    const after = await prisma.event.findUniqueOrThrow({ where: { id: source.event.id } });
    expect(after.status).toBe('PUBLISHED');
    expect(after.coverFileId).toBe(source.cover!.fileId);
  }, 60_000);

  it("copies the cover and the design as new files in the copy's own folder, each with its own StoredFile", async () => {
    const source = await buildSource();
    const res = await duplicate(source.event.id, { name: 'Files', firstDate: NEW_FIRST });
    expect(res.status).toBe(201);
    const copy = await loadCopy(res.body.data.id);

    expect(copy.coverFileId).not.toBe(source.cover!.fileId);
    expect(copy.coverImagePublicId).toMatch(new RegExp(`^dev/t/${tenantId}/e/${copy.id}/cover/[0-9a-f-]{36}$`));
    expect(copy.coverImageUrl).toContain(`/image/upload/`);
    expect(copy.coverImageUrl).toContain(copy.coverImagePublicId!);
    const coverFile = await prisma.storedFile.findUniqueOrThrow({ where: { id: copy.coverFileId! } });
    expect(coverFile).toMatchObject({ kind: 'COVER', status: 'ATTACHED', tenantId, eventId: copy.id, publicId: copy.coverImagePublicId, bytes: 4321, uploadedByUserId: admin.id });
    expect(fakeCloudinary.assets.get(copy.coverImagePublicId!)?.bytes).toBe(4321);

    const [design] = copy.invitationDesigns;
    expect(design).toMatchObject({ kind: 'UPLOAD', width: 800, height: 1200, altText: 'A board', isArchived: false });
    expect(design!.cloudinaryPublicId).toMatch(new RegExp(`^dev/t/${tenantId}/e/${copy.id}/design/[0-9a-f-]{36}$`));
    expect(design!.storedFileId).not.toBe(source.design!.fileId);
    const designFile = await prisma.storedFile.findUniqueOrThrow({ where: { id: design!.storedFileId! } });
    expect(designFile).toMatchObject({ kind: 'INVITATION_DESIGN', status: 'ATTACHED', eventId: copy.id, publicId: design!.cloudinaryPublicId });

    // The originals are still the source's, attached.
    expect(await prisma.storedFile.findUniqueOrThrow({ where: { id: source.cover!.fileId } })).toMatchObject({ status: 'ATTACHED', eventId: source.event.id });
    expect(await prisma.storedFile.findUniqueOrThrow({ where: { id: source.design!.fileId } })).toMatchObject({ status: 'ATTACHED', eventId: source.event.id });
  }, 60_000);

  it('a template design is copied as a template', async () => {
    const source = await buildSource({ withFiles: false });
    await prisma.invitationDesign.create({
      data: { eventId: source.event.id, kind: 'TEMPLATE', templateId: 'classic', templateVersion: 2, overrides: { elements: { title: { color: '#112233' } } }, ...audit() },
    });
    const res = await duplicate(source.event.id, { name: 'Template', firstDate: NEW_FIRST });
    expect(res.status).toBe(201);
    const copy = await loadCopy(res.body.data.id);
    expect(copy.invitationDesigns.map((d) => [d.kind, d.templateId, d.templateVersion, d.overrides])).toEqual([
      ['TEMPLATE', 'classic', 2, { elements: { title: { color: '#112233' } } }],
    ]);
    expect(copy.coverImageUrl).toBeNull();
    expect(res.body.data.duplication).toMatchObject({ coverCopied: false, coverMissing: false, designCopied: true });
  }, 60_000);

  it('a deadline the shift leaves in the past is left empty and reported', async () => {
    const source = await buildSource({ withFiles: false, days: ['2026-01-10', '2026-01-11'] });
    const tomorrow = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
    const res = await duplicate(source.event.id, { name: 'Soon', firstDate: tomorrow });
    expect(res.status).toBe(201);
    expect(res.body.data.duplication.clearedDates).toEqual(['rsvpDeadline', 'registrationClosesAt']);
    const copy = await loadCopy(res.body.data.id);
    expect(copy.rsvpDeadline).toBeNull();
    expect(copy.registrationClosesAt).toBeNull();
    expect(copy.eventDays[0]!.date.toISOString().slice(0, 10)).toBe(tomorrow);
  }, 60_000);
});

describe('the copy is independent of the original', () => {
  it("replacing or clearing the copy's cover never touches the original's", async () => {
    const source = await buildSource();
    const res = await duplicate(source.event.id, { name: 'Independent', firstDate: NEW_FIRST });
    expect(res.status).toBe(201);
    const copyId = res.body.data.id as string;
    const copiedFileId = (await prisma.event.findUniqueOrThrow({ where: { id: copyId } })).coverFileId!;

    const replacement = await signedUpload({ kind: 'COVER', tenantId, eventId: copyId, uploadedBy: { userId: admin.id } });
    const put = await request(app).put(`/api/events/${copyId}`).set(headersFor(admin))
      .send({ name: 'Renamed copy', coverImageUrl: replacement.url, coverImagePublicId: replacement.publicId });
    expect(put.status).toBe(200);

    // The copy's own old cover goes; the original's stays, attached and in Cloudinary.
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { id: copiedFileId } })).status).toMatch(/DELETE_REQUESTED|DELETED/);
    expect(await prisma.storedFile.findUniqueOrThrow({ where: { id: source.cover!.fileId } })).toMatchObject({ status: 'ATTACHED', eventId: source.event.id });
    expect(fakeCloudinary.assets.has(source.cover!.publicId)).toBe(true);
    const original = await prisma.event.findUniqueOrThrow({ where: { id: source.event.id } });
    expect(original).toMatchObject({ name: source.event.name, coverFileId: source.cover!.fileId, coverImagePublicId: source.cover!.publicId });

    // Clearing it, then deleting the copy: still the original's.
    expect((await request(app).put(`/api/events/${copyId}`).set(headersFor(admin)).send({ coverImageUrl: null, coverImagePublicId: null })).status).toBe(200);
    expect((await request(app).delete(`/api/events/${copyId}`).set(headersFor(admin))).status).toBe(200);
    expect(await prisma.storedFile.findUniqueOrThrow({ where: { id: source.cover!.fileId } })).toMatchObject({ status: 'ATTACHED' });
    expect(await prisma.storedFile.findUniqueOrThrow({ where: { id: source.design!.fileId } })).toMatchObject({ status: 'ATTACHED' });
  }, 60_000);
});

describe('guests', () => {
  it('are not copied unless asked', async () => {
    const source = await buildSource({ withFiles: false });
    const res = await duplicate(source.event.id, { name: 'No guests', firstDate: NEW_FIRST, copyGuests: false });
    expect(res.status).toBe(201);
    expect(await prisma.guest.count({ where: { eventId: res.body.data.id } })).toBe(0);
  }, 60_000);

  it('when asked: active guests who are not plus-ones, with contacts, mapped days and plus-ones, never their replies', async () => {
    const source = await buildSource({ withFiles: false });
    const res = await duplicate(source.event.id, { name: 'With guests', firstDate: NEW_FIRST, copyGuests: true });
    expect(res.status).toBe(201);
    expect(res.body.data.duplication.guestsCopied).toBe(2);
    const copy = await loadCopy(res.body.data.id);
    const [c1, c2] = copy.eventDays;
    const byName = new Map(copy.guests.map((g) => [g.firstName ?? "", g] as const));
    expect([...byName.keys()].sort()).toEqual(["Ann", "Bo"]);

    expect(byName.get('Ann')).toMatchObject({ surname: 'Plain', email: source.guests.plain.email, phoneNumber: null, plusOnesAllowed: 0, hostGuestId: null, pendingApproval: false, selfRegisteredAt: null });
    expect(byName.get('Bo')).toMatchObject({ phoneNumber: '+27820000001', email: null, plusOnesAllowed: 2 });
    const daysOf = (name: string) => byName.get(name)!.invites.flatMap((i) => i.inviteEventDay.map((d) => d.eventDayId)).sort();
    expect(daysOf('Ann')).toEqual([c1!.id]);
    expect(daysOf('Bo')).toEqual([c1!.id, c2!.id].sort());

    // A fresh, unsent invitation each (it holds their days): no reply,
    // no status, no short code, no check-in.
    for (const guest of copy.guests) {
      expect(guest.invites).toHaveLength(1);
      const [inv] = guest.invites;
      expect(inv).toMatchObject({ status: 'PENDING', used: false, deliveredAt: null, shortCode: null, smsStatus: null, lastRemindedAt: null });
      expect(inv!.rsvpResponses).toEqual([]);
      expect(inv!.attendances).toEqual([]);
      expect(inv!.checkIns).toEqual([]);
    }
    const sourceTokens = (await prisma.invite.findMany({ where: { eventId: source.event.id }, select: { token: true } })).map((i) => i.token);
    for (const guest of copy.guests) expect(sourceTokens).not.toContain(guest.invites[0]!.token);
    expect(sentEmails()).toEqual([]);
  }, 60_000);

  it("respect the plan's guest limit: over it, nothing is created", async () => {
    const source = await buildSource();
    withLimits({ maxGuestsPerEvent: 1 });
    const name = `Too many ${randomUUID()}`;
    const res = await duplicate(source.event.id, { name, firstDate: NEW_FIRST, copyGuests: true });
    expect(res.status).toBe(403);
    expect(await prisma.event.count({ where: { name } })).toBe(0);
    // Refused before any file was copied.
    expect(fakeCloudinary.callsTo('upload')).toEqual([]);
  }, 60_000);

  it("a public event's guests can't be copied", async () => {
    const source = await buildSource({ withFiles: false, visibility: 'PUBLIC' });
    const res = await duplicate(source.event.id, { name: 'Public', firstDate: NEW_FIRST, copyGuests: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DUPLICATE_EVENT_GUESTS_PUBLIC_EVENT');
  }, 60_000);
});

describe('the plan\'s event limit', () => {
  it('refuses with EVENT_LIMIT_REACHED, creating and copying nothing', async () => {
    const source = await buildSource();
    const active = await prisma.event.count({ where: { tenantId, isArchived: false, eventPass: null } });
    withLimits({ maxEvents: active });
    const name = `Over the limit ${randomUUID()}`;
    const res = await duplicate(source.event.id, { name, firstDate: NEW_FIRST });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EVENT_LIMIT_REACHED');
    expect(await prisma.event.count({ where: { name } })).toBe(0);
    expect(fakeCloudinary.callsTo('upload')).toEqual([]);
  }, 60_000);

  it('two duplicates at once with room for one: exactly one is created (checked under the creation lock)', async () => {
    const source = await buildSource();
    const active = await prisma.event.count({ where: { tenantId, isArchived: false, eventPass: null } });
    withLimits({ maxEvents: active + 1 });
    const tag = randomUUID();
    const results = await Promise.all([
      duplicate(source.event.id, { name: `Race A ${tag}`, firstDate: NEW_FIRST }),
      duplicate(source.event.id, { name: `Race B ${tag}`, firstDate: NEW_FIRST }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(results.find((r) => r.status === 403)!.body.code).toBe('EVENT_LIMIT_REACHED');
    expect(await prisma.event.count({ where: { name: { contains: tag } } })).toBe(1);
    // The loser's copied files are requested for deletion.
    const loserFiles = await prisma.storedFile.findMany({
      where: { tenantId, eventId: null, kind: { in: ['COVER', 'INVITATION_DESIGN'] }, uploadedByUserId: admin.id, status: { in: ['SIGNED', 'UPLOADED'] } },
    });
    expect(loserFiles).toEqual([]);
  }, 60_000);
});

describe('files already gone', () => {
  it('a purged cover (its row deleted, its fields cleared) gives a copy without one, no error', async () => {
    const source = await buildSource();
    await prisma.storedFile.update({ where: { id: source.cover!.fileId }, data: { status: 'DELETED', deletedAt: new Date() } });
    fakeCloudinary.assets.delete(source.cover!.publicId);
    const res = await duplicate(source.event.id, { name: 'Purged', firstDate: NEW_FIRST });
    expect(res.status).toBe(201);
    expect(res.body.data.duplication).toMatchObject({ coverCopied: false, coverMissing: true, designCopied: true });
    const copy = await loadCopy(res.body.data.id);
    expect([copy.coverImageUrl, copy.coverImagePublicId, copy.coverFileId]).toEqual([null, null, null]);
  }, 60_000);

  it('a cover Cloudinary no longer has (row still attached) and a design whose purge cleared it: none, no error', async () => {
    const source = await buildSource();
    fakeCloudinary.assets.delete(source.cover!.publicId);
    await prisma.storedFile.update({ where: { id: source.design!.fileId }, data: { status: 'DELETE_REQUESTED' } });
    const res = await duplicate(source.event.id, { name: 'Gone in Cloudinary', firstDate: NEW_FIRST });
    expect(res.status).toBe(201);
    expect(res.body.data.duplication).toMatchObject({ coverMissing: true, designMissing: true, coverCopied: false, designCopied: false });
    const copy = await loadCopy(res.body.data.id);
    expect(copy.coverFileId).toBeNull();
    expect(copy.invitationDesigns).toEqual([]);
    expect(await prisma.storedFile.count({ where: { publicId: { startsWith: `dev/t/${tenantId}/e/${copy.id}/` } } })).toBe(0);
  }, 60_000);
});

describe('all or nothing', () => {
  it('a copy that fails after its files were copied leaves no event, and its files are deleted', async () => {
    const source = await buildSource();
    vi.spyOn(guestRepository, 'bulkCreateWithInvites').mockRejectedValueOnce(new Error('database fell over'));
    const name = `Fails ${randomUUID()}`;
    const res = await duplicate(source.event.id, { name, firstDate: NEW_FIRST, copyGuests: true });
    expect(res.status).toBe(500);

    expect(await prisma.event.count({ where: { name } })).toBe(0);
    const uploads = fakeCloudinary.callsTo('upload').map((c) => c.publicIds[0]!);
    expect(uploads).toHaveLength(2);
    const rows = await prisma.storedFile.findMany({ where: { publicId: { in: uploads } } });
    expect(rows.map((r) => r.status)).toEqual(['DELETED', 'DELETED']);
    for (const id of uploads) expect(fakeCloudinary.assets.has(id)).toBe(false);
    // Nothing else was written for it.
    const newEventId = uploads[0]!.split('/')[4]!;
    expect(await prisma.eventDay.count({ where: { eventId: newEventId } })).toBe(0);
    expect(await prisma.guest.count({ where: { eventId: newEventId } })).toBe(0);
    // The original's files are untouched.
    expect(await prisma.storedFile.findUniqueOrThrow({ where: { id: source.cover!.fileId } })).toMatchObject({ status: 'ATTACHED' });
  }, 60_000);

  it('Cloudinary refusing a copy is 503 FILE_COPY_FAILED, nothing created, the started copy requested for deletion', async () => {
    const source = await buildSource();
    fakeCloudinary.failCopy = true;
    const name = `No Cloudinary ${randomUUID()}`;
    const res = await duplicate(source.event.id, { name, firstDate: NEW_FIRST });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('FILE_COPY_FAILED');
    expect(await prisma.event.count({ where: { name } })).toBe(0);
    const started = fakeCloudinary.callsTo('upload').map((c) => c.publicIds[0]!);
    expect(started).toHaveLength(1);
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { publicId: started[0]! } })).status).toMatch(/DELETE_REQUESTED|DELETED/);
  }, 60_000);
});

describe('who may duplicate, and which events', () => {
  it("a locked member duplicates an assigned event and is assigned to the copy; another event is a 404", async () => {
    const assigned = await buildSource({ withFiles: false });
    const other = await buildSource({ withFiles: false });
    await assign(tenantId, member.id, assigned.event.id, admin.id);
    try {
      const res = await duplicate(assigned.event.id, { name: 'Member copy', firstDate: NEW_FIRST }, member);
      expect(res.status).toBe(201);
      const assignments = await prisma.eventAssignment.findMany({ where: { eventId: res.body.data.id } });
      expect(assignments.map((a) => a.userId)).toEqual([member.id]);
      expect((await duplicate(other.event.id, { name: 'Not mine', firstDate: NEW_FIRST }, member)).status).toBe(404);
    } finally {
      await prisma.eventAssignment.deleteMany({ where: { userId: member.id } });
    }
  }, 60_000);

  it('another tenant\'s event is a 404', async () => {
    const source = await buildSource({ withFiles: false });
    const otherTenant = await createTenant();
    tenantIds.push(otherTenant.id);
    const outsider = await createActor('TENANT_ADMIN', otherTenant.id);
    expect((await duplicate(source.event.id, { name: 'Steal', firstDate: NEW_FIRST }, outsider)).status).toBe(404);
  }, 60_000);

  it('cancelled, finished and archived events can be duplicated', async () => {
    const cancelled = await buildSource({ withFiles: false });
    await prisma.event.update({ where: { id: cancelled.event.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    const finished = await buildSource({ withFiles: false, days: ['2025-05-01', '2025-05-02'] });
    const archived = await buildSource({ withFiles: true });
    expect((await request(app).delete(`/api/events/${archived.event.id}`).set(headersFor(admin))).status).toBe(200);
    for (const source of [cancelled, finished, archived]) {
      const res = await duplicate(source.event.id, { name: 'Again', firstDate: NEW_FIRST });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('DRAFT');
      expect(res.body.data.isArchived).toBe(false);
    }
  }, 60_000);

  it('refuses a missing name, a missing or past first date, and a non-boolean copyGuests', async () => {
    const source = await buildSource({ withFiles: false });
    expect((await duplicate(source.event.id, { firstDate: NEW_FIRST })).status).toBe(422);
    const noDate = await duplicate(source.event.id, { name: 'x' });
    expect([noDate.status, noDate.body.code]).toEqual([422, 'DUPLICATE_EVENT_DATE_INVALID']);
    const badDate = await duplicate(source.event.id, { name: 'x', firstDate: '2027-02-30' });
    expect([badDate.status, badDate.body.code]).toEqual([422, 'DUPLICATE_EVENT_DATE_INVALID']);
    const past = await duplicate(source.event.id, { name: 'x', firstDate: '2020-01-01' });
    expect([past.status, past.body.code]).toEqual([422, 'EVENT_DAY_DATE_IN_PAST']);
    expect((await duplicate(source.event.id, { name: 'x', firstDate: NEW_FIRST, copyGuests: 'yes' })).status).toBe(400);
  }, 60_000);
});
