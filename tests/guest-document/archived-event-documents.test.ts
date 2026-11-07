import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import request from 'supertest';

// ─────────────────────────────────────────
//  AN ARCHIVED EVENT'S DOCUMENTS (STEERING "Archived events: Memory Hub
//  retention")
//
//  Archiving an event (the organiser's "Archive Event": DELETE
//  /api/events/:id) keeps its guests' documents, as it keeps its photos:
//  - for 30 days, still downloadable by its organisers, read-only (the
//    document list and the 5-minute link, both open on an archived event);
//  - restoring it within that time keeps them;
//  - the archived-media purge deletes them with the photos, after its
//    7-day reminder, which says documents go too.
//  Every deletion is the storage worker's (the fake Cloudinary's destroy),
//  and with storageRetention off no document is deleted (the purge takes
//  the photos only; the storage retention sweep takes the documents once it
//  may, after its resume's 7 days).
//
//  Time is moved by passing `now` to the sweeps: day N is N days after the
//  real archive. Each sweep runs over the whole test database, so every
//  assertion looks at this suite's own events only.
// ─────────────────────────────────────────

const { mockUpload } = vi.hoisted(() => ({ mockUpload: vi.fn() }));
vi.mock('../../src/shared/cloudinary/cloudinary-private-asset.util.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/cloudinary/cloudinary-private-asset.util.js')>()),
  uploadPrivateRawAsset: mockUpload,
}));

import app from '../../src/app.js';
import { createActor, createTenant, createEventWithDay, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { addPhoto, cleanupTenants, type TestEvent } from '../feedback/helpers.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { clearSentEmails, sentEmails } from '../helpers/sent-emails.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { mediaRetentionService } from '../../src/modules/media-retention/media-retention.service.js';
import { storageRetentionService } from '../../src/modules/storage-retention/storage-retention.service.js';
import { memoryHubFolder } from '../../src/modules/upload/upload-folders.js';
import { ROUTE_NOT_FOUND_BODY } from '../../src/shared/middleware/feature.middleware.js';
import { formatGuestDate } from '../../src/shared/utils/guest-date.util.js';

vi.setConfig({ testTimeout: 120_000 });

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
const BASE = 'https://app.example.test';

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;
let vendor: Actor;
let outsider: Actor;
let superAdmin: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  vendor = await createActor('EVENT_VENDOR', tenant.id);
  superAdmin = await createActor('SUPER_ADMIN', null);
  const other = await createTenant();
  tenantIds.push(other.id);
  outsider = await createActor('TENANT_ADMIN', other.id);
}, 60_000);

// The storage retention sweep has been running with its flag on all along
// (as of `now`): no resume, so its 7-day floor is long past.
const STATE = { id: 'singleton' };
const runningAllAlong = (now: Date) =>
  prisma.storageRetentionState.upsert({
    where: STATE,
    create: { ...STATE, lastSweptAt: new Date(now.getTime() - MINUTE), resumedAt: new Date(now.getTime() - 30 * DAY_MS) },
    update: { lastSweptAt: new Date(now.getTime() - MINUTE), resumedAt: new Date(now.getTime() - 30 * DAY_MS) },
  });

beforeEach(async () => {
  await runningAllAlong(new Date());
  installFirebaseMock();
  vi.stubEnv('FRONTEND_BASE_URL', BASE);
  clearSentEmails();
  mockUpload.mockReset();
  mockUpload.mockImplementation(async (publicId: string, file: Buffer) => ({ ok: true, publicId, bytes: file.length }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  await cleanupTenants(tenantIds.splice(0));
}, 120_000);

// ── Fixtures ──────────────────────────────

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(300), Buffer.from('\n%%EOF\n')]);

interface DocEvent {
  eventId: string;
  dayId: string;
  fieldId: string;
  hub: TestEvent;
}

// A published event in March 2027 (open to replies) with a DOCUMENT
// question and its Memory Hub.
const docEvent = async (name?: string): Promise<DocEvent> => {
  const { event, day } = await createEventWithDay(tenantId, organiser.id, name);
  const field = await prisma.rsvpField.create({
    data: { eventId: event.id, label: 'Proof of payment', fieldType: 'DOCUMENT', isRequired: false, order: 0, createdBy: organiser.id, updatedBy: organiser.id },
  });
  const hub = await prisma.memoryHub.findUniqueOrThrow({ where: { eventId: event.id } });
  return { eventId: event.id, dayId: day.id, fieldId: field.id, hub: { event, hubId: hub.id, folder: memoryHubFolder(tenantId, event.id) } };
};

// A guest who replied with a document.
const received = async (setup: DocEvent) => {
  const { guest, invite } = await guestRepository.createWithInvite(setup.eventId, organiser.id, {
    firstName: 'Thandi',
    surname: 'Nkosi',
    email: `guest-${randomBytes(6).toString('hex')}@test.invalid`,
    phoneNumber: null,
    eventDayIds: [setup.dayId],
    plusOnesAllowed: 0,
  });
  const upload = await request(app)
    .post('/api/rsvp/documents')
    .field('token', invite.token)
    .field('rsvpFieldId', setup.fieldId)
    .attach('file', PDF, 'Proof of payment.pdf');
  expect(upload.status).toBe(201);
  const reply = await request(app).post('/api/rsvp/submit').send({
    token: invite.token,
    attending: true,
    attendingDayIds: [setup.dayId],
    rsvpResponses: [{ rsvpFieldId: setup.fieldId, value: upload.body.data.id }],
  });
  expect(reply.status).toBe(200);
  return { guestId: guest.id, documentId: upload.body.data.id as string };
};

const documentRow = (id: string) => prisma.guestDocument.findUniqueOrThrow({ where: { id } });
const isDeleted = async (id: string) => (await documentRow(id)).deletedAt !== null;
const destroyed = (publicId: string) => fakeCloudinary.destroyedIds().includes(publicId);

// The organiser's "Archive Event". Returns the time it was archived.
const archive = async (setup: DocEvent): Promise<Date> => {
  expect((await request(app).delete(`/api/events/${setup.eventId}`).set(headersFor(organiser))).status).toBe(200);
  return (await prisma.event.findUniqueOrThrow({ where: { id: setup.eventId } })).archivedAt!;
};

const dayAfter = (archivedAt: Date, days: number) => new Date(archivedAt.getTime() + days * DAY_MS + MINUTE);

// The archived-media sweep at `now`, the storage retention sweep having run
// all along.
const mediaSweepAt = async (now: Date) => {
  await runningAllAlong(now);
  return mediaRetentionService.sweep(now);
};

const remindersFor = (eventId: string) => sentEmails().filter((e) => e.text.includes(`/events/${eventId}/manage`));

const listDocuments = (eventId: string, actor: Actor = organiser) =>
  request(app).get(`/api/events/${eventId}/documents`).set(headersFor(actor));
const linkFor = (eventId: string, documentId: string, actor: Actor = organiser) =>
  request(app).get(`/api/events/${eventId}/documents/${documentId}/link`).set(headersFor(actor));

// ── Archiving keeps them, read-only ───────

describe('archiving an event keeps its documents', () => {
  it('nothing is deleted; organisers can still list and download them; the detail counts them and gives the purge date', async () => {
    const setup = await docEvent();
    const { guestId, documentId } = await received(setup);
    const before = await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser));
    // What the confirmation before archiving can say.
    expect(before.body.data.documentStorage).toMatchObject({ documentCount: 1, usedBytes: PDF.length });

    await archive(setup);

    expect(await documentRow(documentId)).toMatchObject({ deleteRequestedAt: null, deletedAt: null });
    expect(destroyed((await documentRow(documentId)).cloudinaryPublicId)).toBe(false);

    const list = await listDocuments(setup.eventId);
    expect(list.status).toBe(200);
    expect(list.body.data.documents).toEqual([{
      id: documentId,
      fileName: 'Proof of payment.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      uploadedAt: expect.any(String),
      question: { id: setup.fieldId, label: 'Proof of payment' },
      guest: { id: guestId, firstName: 'Thandi', surname: 'Nkosi', isArchived: false },
    }]);
    const link = await linkFor(setup.eventId, documentId);
    expect(link.status).toBe(200);
    expect(link.body.data).toMatchObject({ fileName: 'Proof of payment.pdf', url: expect.stringContaining('/raw/download') });

    const detail = await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser));
    expect(detail.status).toBe(200);
    expect(detail.body.data.documentStorage).toMatchObject({ documentCount: 1, usedBytes: PDF.length });
    expect(detail.body.data.documentStorage.deletesAt).toBe(detail.body.data.mediaPurgeAt);
    expect(detail.body.data.mediaPurgeAt).not.toBeNull();

    // Read-only: the guest list stays closed, and the same tenant scoping
    // and role gate as ever.
    expect((await request(app).get(`/api/events/${setup.eventId}/guests`).set(headersFor(organiser))).status).toBe(404);
    expect((await listDocuments(setup.eventId, outsider)).status).toBe(404);
    expect((await linkFor(setup.eventId, documentId, outsider)).status).toBe(404);
    const vendors = await listDocuments(setup.eventId, vendor);
    expect(vendors.status).toBe(404);
    expect(vendors.body).toEqual(ROUTE_NOT_FOUND_BODY);
  });
});

// ── The purge takes them, after its reminder ──

describe('the archived-media purge', () => {
  it('keeps them on day 29, reminds about photos and documents a week before, and deletes both on day 30', async () => {
    const setup = await docEvent('Chess <b>open</b>');
    const photo = await addPhoto(setup.hub);
    const { documentId } = await received(setup);
    const { cloudinaryPublicId } = await documentRow(documentId);
    const archivedAt = await archive(setup);

    await mediaSweepAt(dayAfter(archivedAt, 23));
    const [reminder, ...more] = remindersFor(setup.eventId);
    expect(more).toEqual([]);
    const date = formatGuestDate(dayAfter(archivedAt, 30));
    expect(reminder!.subject).toBe(`Photos and documents from Chess bopen/b will be deleted on ${date}`);
    expect(reminder!.text).toContain('its Memory Hub photos and videos, and the documents its guests uploaded, will be permanently deleted');
    expect(reminder!.text).toContain('Download your photos and documents');
    // A file name never goes in the email.
    expect(reminder!.text).not.toContain('Proof of payment.pdf');

    await mediaSweepAt(dayAfter(archivedAt, 29));
    expect(await isDeleted(documentId)).toBe(false);
    expect((await listDocuments(setup.eventId)).body.data.documents).toHaveLength(1);

    const result = await mediaSweepAt(dayAfter(archivedAt, 30));
    expect(result.purges.find((p) => p.eventId === setup.eventId)).toMatchObject({ completed: true, purgedCount: 2, failedCount: 0 });
    expect(await isDeleted(documentId)).toBe(true);
    expect(destroyed(cloudinaryPublicId)).toBe(true);
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: photo.id } })).purgedAt).not.toBeNull();
    expect((await listDocuments(setup.eventId)).body.data.documents).toEqual([]);
    expect((await linkFor(setup.eventId, documentId)).status).toBe(404);
  });

  it('an event with only documents is reminded about its documents, and its purge waits for that reminder', async () => {
    const setup = await docEvent('Club AGM');
    const { documentId } = await received(setup);
    const archivedAt = await archive(setup);

    // Nothing to download in its Memory Hub, but documents: never purged
    // without the reminder, here one not sent by day 31 (the email failing
    // to be claimed, as if the sweep were down).
    const realRemindFor = mediaRetentionService.remindFor;
    const skip = vi.spyOn(mediaRetentionService, 'remindFor').mockImplementation(async (eventId, now) =>
      eventId === setup.eventId ? null : realRemindFor(eventId, now)
    );
    const unreminded = await mediaSweepAt(dayAfter(archivedAt, 31));
    skip.mockRestore();
    expect(unreminded.purges.find((p) => p.eventId === setup.eventId)).toBeUndefined();
    expect(await isDeleted(documentId)).toBe(false);

    // The next sweep sends it (late, so the purge is a week from it).
    const remindedAt = dayAfter(archivedAt, 32);
    await mediaSweepAt(remindedAt);
    const [reminder] = remindersFor(setup.eventId);
    const date = formatGuestDate(new Date(remindedAt.getTime() + 7 * DAY_MS));
    expect(reminder!.subject).toBe(`Documents from Club AGM will be deleted on ${date}`);
    expect(reminder!.text).toContain('the documents its guests uploaded will be permanently deleted');
    expect(reminder!.text).toContain('Download your documents');
    expect(reminder!.html).toContain(`href="${BASE}/events/${setup.eventId}/manage"`);
    expect(reminder!.text).not.toMatch(/photos/i);

    await mediaSweepAt(new Date(remindedAt.getTime() + 7 * DAY_MS - MINUTE));
    expect(await isDeleted(documentId)).toBe(false);
    await mediaSweepAt(new Date(remindedAt.getTime() + 7 * DAY_MS + MINUTE));
    expect(await isDeleted(documentId)).toBe(true);
  });
});

// ── Restoring keeps them ──────────────────

describe('restoring the event', () => {
  it('on day 10 keeps its documents, past the 30 days', async () => {
    const setup = await docEvent();
    const { documentId } = await received(setup);
    await archive(setup);
    // Archived ten days ago, then restored.
    const archivedAt = new Date(Date.now() - 10 * DAY_MS);
    await prisma.event.update({ where: { id: setup.eventId }, data: { archivedAt } });
    expect((await request(app).post(`/api/events/${setup.eventId}/reactivate`).set(headersFor(superAdmin))).status).toBe(200);

    await mediaSweepAt(dayAfter(archivedAt, 23));
    await mediaSweepAt(dayAfter(archivedAt, 31));
    expect(remindersFor(setup.eventId)).toEqual([]);
    expect(await isDeleted(documentId)).toBe(false);
    expect((await linkFor(setup.eventId, documentId)).status).toBe(200);
    const detail = await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser));
    expect(detail.body.data.documentStorage).toMatchObject({ documentCount: 1, deletesAt: null });
  });
});

// ── storageRetention off ──────────────────

describe('storageRetention off', () => {
  it('the purge takes the photos and no document, and the reminder only mentions photos; back on, the documents go after the 7 days', async () => {
    const setup = await docEvent();
    const photo = await addPhoto(setup.hub);
    const { documentId } = await received(setup);
    const archivedAt = await archive(setup);

    vi.stubEnv('FEATURES_DISABLED', 'storageRetention');
    await mediaSweepAt(dayAfter(archivedAt, 23));
    const [reminder] = remindersFor(setup.eventId);
    expect(reminder!.subject).toMatch(/^Photos from /);
    expect(reminder!.text).not.toMatch(/document/i);
    const detail = await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser));
    expect(detail.body.data.documentStorage.deletesAt).toBeNull();

    const purged = await mediaSweepAt(dayAfter(archivedAt, 30));
    expect(purged.purges.find((p) => p.eventId === setup.eventId)).toMatchObject({ completed: true, purgedCount: 1 });
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: photo.id } })).purgedAt).not.toBeNull();
    expect(await isDeleted(documentId)).toBe(false);
    expect((await documentRow(documentId)).deleteRequestedAt).toBeNull();
    // Still downloadable meanwhile.
    expect((await linkFor(setup.eventId, documentId)).status).toBe(200);

    // Back on after two days off: the first sweep records a resume and
    // deletes nothing; seven days after it, the documents go.
    vi.unstubAllEnvs();
    const backOn = dayAfter(archivedAt, 32);
    await prisma.storageRetentionState.update({ where: STATE, data: { lastSweptAt: dayAfter(archivedAt, 30) } });
    const resumed = await storageRetentionService.sweep(backOn);
    expect(resumed.archivedEventDocuments.find((d) => d.eventId === setup.eventId)).toBeUndefined();
    expect((await documentRow(documentId)).deleteRequestedAt).toBeNull();

    const weekOn = new Date(backOn.getTime() + 7 * DAY_MS + MINUTE);
    await prisma.storageRetentionState.update({ where: STATE, data: { lastSweptAt: new Date(weekOn.getTime() - MINUTE) } });
    const after = await storageRetentionService.sweep(weekOn);
    expect(after.archivedEventDocuments).toContainEqual({ eventId: setup.eventId, requestedCount: 1 });
    expect(await isDeleted(documentId)).toBe(true);
  });
});
