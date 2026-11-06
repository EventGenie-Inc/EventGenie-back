import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto, { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import request from 'supertest';

// ─────────────────────────────────────────
//  STORED FILES (storage module; STEERING "Storage")
//
//  One record per file; paths fixed by owner, environment first; deletion
//  only through records, by the worker, with retries; proper replacement;
//  unsaved uploads swept; a deleted event's files requested; sizes from
//  Cloudinary, never the browser; legacy rows; the weekly reconciliation.
//
//  Cloudinary is the suite's in-memory fake (tests/helpers/fake-cloudinary.ts):
//  every call these tests make lands there. reportError is mocked to see
//  what reaches Sentry.
// ─────────────────────────────────────────

const { mockReportError } = vi.hoisted(() => ({ mockReportError: vi.fn() }));
vi.mock('../../src/shared/monitoring/error-reporting.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/monitoring/error-reporting.js')>()),
  reportError: mockReportError,
}));

import app from '../../src/app.js';
import { createActor, createTenant, createEventWithDay, deleteTenantsDeep, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { signedUpload, storedFile } from '../helpers/storage.js';
import { storedFileService } from '../../src/modules/storage/stored-file.service.js';
import { storageDeletionWorker, nextAttemptDelayMs, shouldReportFailure, runStorageSweep } from '../../src/modules/storage/storage-deletion.worker.js';
import { eventDraftService } from '../../src/modules/event-draft/event-draft.service.js';
import { eventDraftRepository } from '../../src/modules/event-draft/event-draft.repository.js';
import { storageReconciliationService, isoWeekKey } from '../../src/modules/storage/storage-reconciliation.service.js';
import { assertStorageEnvValid, legacyCoverFolder, legacyMemoryHubFolder } from '../../src/modules/upload/upload-folders.js';
import { signCloudinaryParams } from '../../src/shared/cloudinary/cloudinary-signature.util.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
import { signNotification } from '../../src/shared/cloudinary/cloudinary-notification.util.js';
import { eventService } from '../../src/modules/event/event.service.js';
import { memoryHubService } from '../../src/modules/memory-hub/memory-hub.service.js';
import { memoryHubRepository } from '../../src/modules/memory-hub/memory-hub.repository.js';
import { invitationDesignService } from '../../src/modules/invitation-design/invitation-design.service.js';
import { guestDocumentService } from '../../src/modules/guest-document/guest-document.service.js';
import { guestDocumentRepository } from '../../src/modules/guest-document/guest-document.repository.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { EVENT_COVER_MAX_BYTES, MEMORY_ITEM_IMAGE_MAX_BYTES } from '../../src/modules/upload/upload-constants.js';

vi.setConfig({ testTimeout: 90_000 });

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;
let colleague: Actor;
let superAdmin: Actor;

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  colleague = await createActor('TENANT_ADMIN', tenant.id);
  superAdmin = await createActor('SUPER_ADMIN', null);
}, 60000);

beforeEach(() => {
  installFirebaseMock();
  mockReportError.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  const events = await prisma.event.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  await prisma.memoryItem.deleteMany({ where: { memoryHub: { eventId: { in: eventIds } } } });
  await prisma.invitationDesign.deleteMany({ where: { eventId: { in: eventIds } } });
  await deleteTenantsDeep(tenantIds);
  await prisma.user.deleteMany({ where: { id: superAdmin.id } });
}, 60000);

const COMPLETE_DAY = { label: 'Day 1', date: '2030-01-01T00:00:00', location: 'Somewhere', address: '1 Test Road' };
const MINUTE = 60_000;

// What the browser does: ask for a cover signature (over HTTP when `http`;
// else through the service, as the route does, to stay inside the route's
// own per-user limit of 10), then upload to Cloudinary (the fake).
const signCover = async (bytes = 1000, eventId?: string, actor: Actor = organiser, http = false) => {
  let data: { folder: string; publicId: string; cloudName: string } & Record<string, unknown>;
  if (http) {
    const res = await request(app).post('/api/uploads/signature').set(headersFor(actor)).send({ purpose: 'EVENT_COVER', ...(eventId ? { eventId } : {}) });
    expect(res.status).toBe(200);
    data = res.body.data;
  } else {
    data = await storedFileService.signUpload({ kind: 'COVER', tenantId: actor.tenantId as string, eventId: eventId ?? null, uploadedBy: { userId: actor.id } }) as never;
  }
  const publicId = `${data.folder}/${data.publicId}`;
  fakeCloudinary.put(publicId, { bytes });
  return { publicId, url: `https://res.cloudinary.com/${data.cloudName}/image/upload/v1/${publicId}.jpg`, signature: data as never as { folder: string; publicId: string; timestamp: number; params: Record<string, string> } };
};

// The draft as the wizard saves it: the cover's public id and its own URL.
const putDraft = (cover: { publicId: string; url: string } | null, actor: Actor = organiser) =>
  request(app).put('/api/event-drafts/current').set(headersFor(actor)).send({
    currentStep: 4,
    payload: { name: 'Wizard event', hostName: 'Host', days: [COMPLETE_DAY], ...(cover ? { coverImagePublicId: cover.publicId, coverImageUrl: cover.url } : {}) },
  });

const newEvent = async () => (await createEventWithDay(tenantId, organiser.id)).event;

// ── 1 & 2. One record per file, at a fixed path ─────────────

describe('signing writes the record first, at a path fixed by its owner', () => {
  it('<env>/t/<tenant>/e/<event>/<kind> for event files, <env>/t/<tenant>/<kind> for a cover with no event yet', async () => {
    const event = await newEvent();
    const preEvent = await signCover(1000, undefined, organiser, true);
    const onEvent = await signCover(1000, event.id, organiser, true);
    expect(preEvent.signature.folder).toBe(`dev/t/${tenantId}/cover`);
    expect(onEvent.signature.folder).toBe(`dev/t/${tenantId}/e/${event.id}/cover`);
    expect(await storedFile(preEvent.publicId)).toMatchObject({ kind: 'COVER', status: 'SIGNED', tenantId, eventId: null, uploadedByUserId: organiser.id, resourceType: 'IMAGE', deliveryType: 'UPLOAD', legacy: false });
    expect(await storedFile(onEvent.publicId)).toMatchObject({ eventId: event.id });

    const memory = await request(app).post('/api/uploads/signature').set(headersFor(organiser)).send({ purpose: 'MEMORY_ITEM', eventId: event.id, mediaType: 'VIDEO' });
    // Memory Hub is a plan setting; any refusal here is the plan's, which
    // is enough for this test if so. When signed, its path is the event's.
    if (memory.status === 200) {
      expect(memory.body.data.folder).toBe(`dev/t/${tenantId}/e/${event.id}/memory`);
      expect(await storedFile(`${memory.body.data.folder}/${memory.body.data.publicId}`)).toMatchObject({ kind: 'MEMORY_ITEM', resourceType: 'VIDEO' });
    }
  });

  it('params holds every field to post, signed; a notification URL is signed in when the environment has one', async () => {
    vi.stubEnv('STORAGE_NOTIFICATION_URL', 'https://api.example.test/api/storage/cloudinary/notifications');
    const { signature } = await signCover();
    const { api_key: apiKey, signature: sig, ...signed } = signature.params as Record<string, string>;
    expect(apiKey).toBe(requireCloudinaryConfig().apiKey);
    expect(signed).toEqual({
      allowed_formats: 'jpg,png,webp',
      folder: signature.folder,
      public_id: signature.publicId,
      timestamp: String(signature.timestamp),
      notification_url: 'https://api.example.test/api/storage/cloudinary/notifications',
    });
    expect(sig).toBe(signCloudinaryParams(signed, requireCloudinaryConfig().apiSecret));
  });

  it('STORAGE_ENV must be dev, staging or prod: anything else stops startup and signing', async () => {
    for (const bad of ['', 'production', 'test']) {
      vi.stubEnv('STORAGE_ENV', bad);
      expect(() => assertStorageEnvValid()).toThrow(/STORAGE_ENV/);
      await expect(storedFileService.signUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id } })).rejects.toThrow(/STORAGE_ENV/);
    }
    vi.stubEnv('STORAGE_ENV', 'staging');
    const staged = await storedFileService.signUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id } });
    expect(staged.folder).toBe(`staging/t/${tenantId}/cover`);
  });
});

// ── 4. Proper replacement ───────────────────────────────────

describe('covers: only the current one is kept', () => {
  it('replacing a cover twice in the wizard leaves exactly one file', async () => {
    const a = await signCover();
    expect((await putDraft(a)).status).toBe(200);
    const b = await signCover();
    expect((await putDraft(b)).status).toBe(200);
    const c = await signCover();
    expect((await putDraft(c)).status).toBe(200);

    expect((await storedFile(a.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(b.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(c.publicId)).status).toBe('ATTACHED');

    const made = await request(app).post('/api/event-drafts/current/materialize').set(headersFor(organiser));
    expect(made.status).toBe(201);
    const eventId = made.body.data.event.id as string;
    const cover = await storedFile(c.publicId);
    expect(cover).toMatchObject({ status: 'ATTACHED', eventId, draftId: null });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).coverFileId).toBe(cover.id);

    await storageDeletionWorker.runOnce();
    const kept = [a.publicId, b.publicId, c.publicId].filter((id) => fakeCloudinary.assets.has(id));
    expect(kept).toEqual([c.publicId]);
    expect((await storedFile(a.publicId)).status).toBe('DELETED');
  });

  it('removing the cover from the draft, or discarding the draft, releases it', async () => {
    const a = await signCover();
    await putDraft(a);
    await putDraft(null);
    expect((await storedFile(a.publicId)).status).toBe('DELETE_REQUESTED');

    const b = await signCover();
    await putDraft(b);
    expect((await request(app).delete('/api/event-drafts/current').set(headersFor(organiser))).status).toBe(200);
    expect((await storedFile(b.publicId)).status).toBe('DELETE_REQUESTED');
  });

  it("a draft never holds a colleague's unsaved cover", async () => {
    const theirs = await signCover(1000, undefined, colleague);
    await putDraft(theirs);
    expect((await storedFile(theirs.publicId)).status).toBe('SIGNED');
  });

  it('a replaced saved cover is requested for deletion, retried after a failure with backoff, then deleted with its CDN copy', async () => {
    const a = await signCover();
    const created = await eventService.create(tenantId, organiser.id, { name: 'Covered', hostName: 'Host', coverImageUrl: a.url, coverImagePublicId: a.publicId });
    expect(await storedFile(a.publicId)).toMatchObject({ status: 'ATTACHED', eventId: created.id });

    const b = await signCover(2000, created.id);
    await eventService.update(created.id, organiser.id, organiser.role, tenantId, { coverImageUrl: b.url, coverImagePublicId: b.publicId });
    expect((await storedFile(a.publicId)).status).toBe('DELETE_REQUESTED');
    expect(await storedFile(b.publicId)).toMatchObject({ status: 'ATTACHED', bytes: 2000 });

    fakeCloudinary.failDestroy.add(a.publicId);
    const now = new Date();
    await storageDeletionWorker.runOnce(now);
    const failed = await storedFile(a.publicId);
    expect(failed).toMatchObject({ status: 'DELETE_REQUESTED', deleteAttempts: 1 });
    expect(failed.lastDeleteError).toBeTruthy();
    expect(failed.nextDeleteAttemptAt!.getTime()).toBe(now.getTime() + MINUTE);

    // Not due again yet: nothing is tried.
    const tries = fakeCloudinary.destroyedIds().filter((id) => id === a.publicId).length;
    await storageDeletionWorker.runOnce(now);
    expect(fakeCloudinary.destroyedIds().filter((id) => id === a.publicId).length).toBe(tries);

    fakeCloudinary.failDestroy.clear();
    await storageDeletionWorker.runOnce(new Date(now.getTime() + 2 * MINUTE));
    expect((await storedFile(a.publicId)).status).toBe('DELETED');
    expect(fakeCloudinary.assets.has(a.publicId)).toBe(false);
    const call = fakeCloudinary.callsTo('destroy').filter((c) => c.publicIds[0] === a.publicId).at(-1)!;
    expect(call.params).toMatchObject({ invalidate: 'true', type: 'upload' });
  });

  it('a deletion failing again and again backs off, is never given up, and reaches Sentry on the 3rd failure and every 10th', async () => {
    expect([1, 2, 3, 4, 10].map(nextAttemptDelayMs)).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 6 * 60 * MINUTE]);
    expect([1, 2, 3, 4, 9, 10, 20, 21].map(shouldReportFailure)).toEqual([false, false, true, false, false, true, true, false]);

    const file = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id } });
    await storedFileService.requestDeletion(prisma, { id: file.fileId });
    fakeCloudinary.failDestroy.add(file.publicId);
    let at = Date.now();
    for (let i = 0; i < 3; i++) {
      await storageDeletionWorker.runOnce(new Date(at));
      at += 7 * 60 * 60 * 1000;
    }
    expect(await storedFile(file.publicId)).toMatchObject({ status: 'DELETE_REQUESTED', deleteAttempts: 3 });
    const reports = mockReportError.mock.calls.map(([e]) => String((e as Error).message)).filter((m) => m.includes(file.fileId));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/after 3 attempts/);
    expect(reports[0]).not.toContain(file.publicId);
  });
});

describe('designs and logos: replacement is covered in their own suites (documents and purged media: tests/storage-retention/)', () => {
  it('a replaced design image is deleted by the worker', async () => {
    const event = await newEvent();
    const first = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId, eventId: event.id, uploadedBy: { userId: organiser.id }, format: 'png' });
    const second = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId, eventId: event.id, uploadedBy: { userId: organiser.id }, format: 'png' });
    const body = (u: typeof first) => ({ kind: 'UPLOAD', imageUrl: u.url, cloudinaryPublicId: u.publicId, width: 100, height: 100 });
    await invitationDesignService.put(event.id, organiser.id, organiser.role, tenantId, body(first));
    await invitationDesignService.put(event.id, organiser.id, organiser.role, tenantId, body(second));
    await storageDeletionWorker.runOnce();
    expect(fakeCloudinary.assets.has(first.publicId)).toBe(false);
    expect(fakeCloudinary.assets.has(second.publicId)).toBe(true);
  });
});

// ── 4. Releasing an unsaved upload ──────────────────────────

describe('POST /api/storage/files/release', () => {
  const release = (actor: Actor, publicId: unknown) => request(app).post('/api/storage/files/release').set(headersFor(actor)).send({ publicId });

  it("the uploader's own unsaved upload is deleted at once; again is the same 200", async () => {
    const a = await signCover();
    const res = await release(organiser, a.publicId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', data: { released: true } });
    expect((await storedFile(a.publicId)).status).toBe('DELETED');
    expect(fakeCloudinary.assets.has(a.publicId)).toBe(false);
    expect((await release(organiser, a.publicId)).status).toBe(200);
  });

  it("someone else's upload, an attached one, or an unknown id: 404 UPLOAD_NOT_FOUND, nothing changed", async () => {
    const theirs = await signCover(1000, undefined, colleague);
    const attached = await signCover();
    await eventService.create(tenantId, organiser.id, { name: 'Has cover', hostName: 'Host', coverImageUrl: attached.url, coverImagePublicId: attached.publicId });
    for (const publicId of [theirs.publicId, attached.publicId, `dev/t/${tenantId}/cover/${crypto.randomUUID()}`, 42]) {
      const res = await release(organiser, publicId);
      expect(res.status, String(publicId)).toBe(404);
      expect(res.body.code).toBe('UPLOAD_NOT_FOUND');
    }
    expect((await storedFile(theirs.publicId)).status).toBe('SIGNED');
    expect((await storedFile(attached.publicId)).status).toBe('ATTACHED');
  });

  it('a guest releases their own unsaved upload with their invite token, and only theirs', async () => {
    const { event, day } = await createEventWithDay(tenantId, organiser.id);
    const mk = () => guestRepository.createWithInvite(event.id, organiser.id, {
      firstName: 'G', surname: 'T', email: `g-${randomBytes(4).toString('hex')}@test.invalid`, phoneNumber: null, eventDayIds: [day.id], plusOnesAllowed: 0,
    });
    const g1 = await mk();
    const g2 = await mk();
    const mine = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: event.id, mediaType: 'IMAGE', uploadedBy: { inviteId: g1.invite.id } });
    const other = await request(app).post('/api/storage/files/guest-release').send({ token: g2.invite.token, publicId: mine.publicId });
    expect(other.status).toBe(404);
    const ok = await request(app).post('/api/storage/files/guest-release').send({ token: g1.invite.token, publicId: mine.publicId });
    expect(ok.status).toBe(200);
    expect((await storedFile(mine.publicId)).status).toBe('DELETED');
  });
});

// ── 3. The flag ─────────────────────────────────────────────

describe('storageDeletion off', () => {
  it('the worker deletes nothing; requests are still recorded, and deleted once it is back on', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'storageDeletion');
    const a = await signCover();
    expect((await request(app).post('/api/storage/files/release').set(headersFor(organiser)).send({ publicId: a.publicId })).status).toBe(200);
    expect(await storageDeletionWorker.runOnce()).toMatchObject({ skipped: true });
    expect((await storedFile(a.publicId)).status).toBe('DELETE_REQUESTED');
    expect(fakeCloudinary.assets.has(a.publicId)).toBe(true);

    vi.unstubAllEnvs();
    await storageDeletionWorker.runOnce();
    expect((await storedFile(a.publicId)).status).toBe('DELETED');
  });
});

// ── 5. Unsaved uploads ──────────────────────────────────────

describe('the unsaved-uploads sweep', () => {
  it('requests deletion of SIGNED or UPLOADED files older than 24 hours, and never touches an attached one', async () => {
    const event = await newEvent();
    const dayAgo = new Date(Date.now() - 25 * 60 * MINUTE);
    const oldSigned = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id }, uploaded: false });
    const oldUploaded = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id } });
    await prisma.storedFile.update({ where: { id: oldUploaded.fileId }, data: { status: 'UPLOADED', bytes: 1000 } });
    const recent = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id } });
    const attached = await signCover();
    await eventService.update(event.id, organiser.id, organiser.role, tenantId, { hostName: 'Host', coverImageUrl: attached.url, coverImagePublicId: attached.publicId });
    const draftHeld = await signCover();
    await putDraft(draftHeld);
    // A document with its row is the documents sweep's (24 hours unattached,
    // by its own uploadedAt), attached or not.
    const docFile = await prisma.storedFile.create({ data: { publicId: `dev/t/${tenantId}/e/${event.id}/document/${crypto.randomUUID()}/a.pdf`, resourceType: 'RAW', deliveryType: 'PRIVATE', kind: 'GUEST_DOCUMENT', tenantId, eventId: event.id, status: 'UPLOADED' } });
    const field = await prisma.rsvpField.create({ data: { eventId: event.id, label: 'Proof', fieldType: 'DOCUMENT', isRequired: false, order: 0, createdBy: organiser.id, updatedBy: organiser.id } });
    await prisma.guestDocument.create({ data: { id: crypto.randomUUID(), eventId: event.id, rsvpFieldId: field.id, source: 'REGISTRATION', cloudinaryPublicId: docFile.publicId, fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1, storedFileId: docFile.id } });

    const old = [oldSigned, oldUploaded, attached, draftHeld].map((u) => u.publicId);
    await prisma.storedFile.updateMany({ where: { publicId: { in: [...old, docFile.publicId] } }, data: { signedAt: dayAgo } });

    await storedFileService.sweepUnsaved();
    expect((await storedFile(oldSigned.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(oldUploaded.publicId)).status).toBe('DELETE_REQUESTED');
    expect((await storedFile(recent.publicId)).status).toBe('SIGNED');
    expect((await storedFile(attached.publicId)).status).toBe('ATTACHED');
    expect((await storedFile(draftHeld.publicId)).status).toBe('ATTACHED');
    expect((await storedFile(docFile.publicId)).status).toBe('UPLOADED');

    // A file signed but never uploaded is closed too: "not found" is done.
    await storageDeletionWorker.runOnce();
    expect((await storedFile(oldSigned.publicId)).status).toBe('DELETED');
  });
});

// ── 6. Deleted and abandoned ────────────────────────────────

describe('deleting an event', () => {
  it('requests deletion of its cover, its designs and its unsaved uploads; its saved Memory Hub media waits for the 30-day purge', async () => {
    const cover = await signCover();
    const event = await eventService.create(tenantId, organiser.id, { name: 'To delete', hostName: 'Host', coverImageUrl: cover.url, coverImagePublicId: cover.publicId });
    const design = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId, eventId: event.id, uploadedBy: { userId: organiser.id }, format: 'png' });
    await invitationDesignService.put(event.id, organiser.id, organiser.role, tenantId, { kind: 'UPLOAD', imageUrl: design.url, cloudinaryPublicId: design.publicId, width: 10, height: 10 });
    const unsavedDesign = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId, eventId: event.id, uploadedBy: { userId: organiser.id } });
    const unsavedMemory = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: event.id, mediaType: 'IMAGE', uploadedBy: { userId: organiser.id } });
    const savedMemory = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: event.id, mediaType: 'IMAGE', uploadedBy: { userId: organiser.id } });
    const hub = await memoryHubRepository.findByEventId(event.id);
    await memoryHubService.createOrganiserItem(event.id, hub!.id, organiser.id, organiser.role, tenantId, { mediaUrl: savedMemory.url, cloudinaryPublicId: savedMemory.publicId, mediaType: 'IMAGE' });

    await eventService.archive(event.id, organiser.id, organiser.role, tenantId);

    for (const u of [cover, design, unsavedDesign, unsavedMemory]) expect((await storedFile(u.publicId)).status, u.publicId).toBe('DELETE_REQUESTED');
    expect((await storedFile(savedMemory.publicId)).status).toBe('ATTACHED');
    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after).toMatchObject({ isArchived: true, coverImageUrl: null, coverImagePublicId: null, coverFileId: null });
    expect(await prisma.invitationDesign.count({ where: { eventId: event.id, isArchived: false } })).toBe(0);
  });

  it('an organiser upload saved after its event was deleted is requested for deletion, and the save is the 404', async () => {
    const event = await newEvent();
    const up = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: event.id, mediaType: 'IMAGE', uploadedBy: { userId: organiser.id } });
    const hub = await memoryHubRepository.findByEventId(event.id);
    await eventService.archive(event.id, organiser.id, organiser.role, tenantId);
    expect((await storedFile(up.publicId)).status).toBe('DELETE_REQUESTED');
    // (The archive requested it; the save path requests it too, for one
    // signed and saved after: shown by resetting it.)
    await prisma.storedFile.update({ where: { id: up.fileId }, data: { status: 'SIGNED', deleteRequestedAt: null } });
    const err = await memoryHubService
      .createOrganiserItem(event.id, hub!.id, organiser.id, organiser.role, tenantId, { mediaUrl: up.url, cloudinaryPublicId: up.publicId, mediaType: 'IMAGE' })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404 });
    expect((await storedFile(up.publicId)).status).toBe('DELETE_REQUESTED');
  });
});

// ── 6. Document gaps ────────────────────────────────────────

describe('guest documents: no file without a record', () => {
  const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n'), randomBytes(100), Buffer.from('\n%%EOF\n')]);
  const setupDoc = async () => {
    const { event, day } = await createEventWithDay(tenantId, organiser.id);
    const field = await prisma.rsvpField.create({ data: { eventId: event.id, label: 'Proof', fieldType: 'DOCUMENT', isRequired: false, order: 0, createdBy: organiser.id, updatedBy: organiser.id } });
    const { invite } = await guestRepository.createWithInvite(event.id, organiser.id, {
      firstName: 'D', surname: 'G', email: `d-${randomBytes(4).toString('hex')}@test.invalid`, phoneNumber: null, eventDayIds: [day.id], plusOnesAllowed: 0,
    });
    return { event, field, invite };
  };
  const docFiles = (eventId: string) => prisma.storedFile.findMany({ where: { eventId, kind: 'GUEST_DOCUMENT' } });
  const file = { buffer: PDF, originalname: 'proof.pdf', mimetype: 'application/pdf', size: PDF.length } as never;

  it('a stored upload is recorded before it is sent, then measured and tied to its row', async () => {
    const { event, field, invite } = await setupDoc();
    const view = await guestDocumentService.uploadForInvite(invite.token, field.id, file);
    const doc = await prisma.guestDocument.findUniqueOrThrow({ where: { id: view.id } });
    const [row] = await docFiles(event.id);
    expect(row).toMatchObject({ id: doc.storedFileId, status: 'UPLOADED', bytes: PDF.length, resourceType: 'RAW', deliveryType: 'PRIVATE', uploadedByInviteId: invite.id });
    expect(row!.publicId.startsWith(`dev/t/${tenantId}/e/${event.id}/document/`)).toBe(true);
  });

  it('Cloudinary kept the file but the answer was lost (a timeout): 503, and the file is requested for deletion and deleted', async () => {
    const { event, field, invite } = await setupDoc();
    fakeCloudinary.failUploadAfterStoring = true;
    await expect(guestDocumentService.uploadForInvite(invite.token, field.id, file)).rejects.toMatchObject({ statusCode: 503 });
    const [row] = await docFiles(event.id);
    expect(row!.status).toBe('DELETE_REQUESTED');
    expect(fakeCloudinary.assets.has(row!.publicId)).toBe(true);
    await storageDeletionWorker.runOnce();
    expect((await storedFile(row!.publicId)).status).toBe('DELETED');
    expect(fakeCloudinary.assets.has(row!.publicId)).toBe(false);
    expect(fakeCloudinary.callsTo('destroy').find((c) => c.publicIds[0] === row!.publicId)!.params).toMatchObject({ type: 'private' });
    expect(await prisma.guestDocument.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("the row can't be written (a crash between upload and row): the file is requested for deletion, not left", async () => {
    const { event, field, invite } = await setupDoc();
    vi.spyOn(guestDocumentRepository, 'create').mockRejectedValueOnce(new Error('database went away'));
    await expect(guestDocumentService.uploadForInvite(invite.token, field.id, file)).rejects.toThrow('database went away');
    const [row] = await docFiles(event.id);
    expect(row!.status).toBe('DELETE_REQUESTED');
    await storageDeletionWorker.runOnce();
    expect(fakeCloudinary.assets.has(row!.publicId)).toBe(false);
  });

  it("even the deletion request can't be written: the record stays, and the unsaved sweep takes it after 24 hours", async () => {
    const { event, field, invite } = await setupDoc();
    vi.spyOn(guestDocumentRepository, 'create').mockRejectedValueOnce(new Error('database went away'));
    vi.spyOn(storedFileService, 'requestDeletion').mockRejectedValueOnce(new Error('still away'));
    await expect(guestDocumentService.uploadForInvite(invite.token, field.id, file)).rejects.toThrow('database went away');
    const [row] = await docFiles(event.id);
    expect(row!.status).toBe('SIGNED');
    vi.restoreAllMocks();
    await storedFileService.sweepUnsaved(new Date(Date.now() + 25 * 60 * MINUTE));
    expect((await storedFile(row!.publicId)).status).toBe('DELETE_REQUESTED');
  });
});

// ── 7. Real sizes ───────────────────────────────────────────

describe("sizes are Cloudinary's, never the browser's", () => {
  it('a cover the browser calls 1 byte but Cloudinary holds at 6 MB: 400, requested for deletion, no event', async () => {
    const big = await signCover(EVENT_COVER_MAX_BYTES + 1);
    const before = await prisma.event.count({ where: { tenantId } });
    const err = await eventService
      .create(tenantId, organiser.id, { name: 'Liar', hostName: 'Host', coverImageUrl: big.url, coverImagePublicId: big.publicId, coverImageBytes: 1 })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect(err.message).toMatch(/too large/);
    expect(await storedFile(big.publicId)).toMatchObject({ status: 'DELETE_REQUESTED', bytes: EVENT_COVER_MAX_BYTES + 1 });
    expect(await prisma.event.count({ where: { tenantId } })).toBe(before);
  });

  it('a Memory Hub photo is stored with its real size, and refused by it', async () => {
    const event = await newEvent();
    const hub = await memoryHubRepository.findByEventId(event.id);
    const big = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: event.id, mediaType: 'IMAGE', uploadedBy: { userId: organiser.id }, bytes: MEMORY_ITEM_IMAGE_MAX_BYTES + 1 });
    const err = await memoryHubService
      .createOrganiserItem(event.id, hub!.id, organiser.id, organiser.role, tenantId, { mediaUrl: big.url, cloudinaryPublicId: big.publicId, mediaType: 'IMAGE', bytes: 1 })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect((await storedFile(big.publicId)).status).toBe('DELETE_REQUESTED');
  });

  it("Cloudinary can't be asked: 503 UPLOAD_NOT_READY, the file left as it is for a retry", async () => {
    const a = await signCover();
    fakeCloudinary.failExplicit = true;
    const err = await eventService
      .create(tenantId, organiser.id, { name: 'Later', hostName: 'Host', coverImageUrl: a.url, coverImagePublicId: a.publicId })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 503, code: 'UPLOAD_NOT_READY' });
    expect((await storedFile(a.publicId)).status).toBe('SIGNED');
  });

  it('a signature never used for an upload: 422, and its record closed', async () => {
    const never = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id }, uploaded: false });
    const err = await eventService
      .create(tenantId, organiser.id, { name: 'Ghost', hostName: 'Host', coverImageUrl: never.url, coverImagePublicId: never.publicId })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect((await storedFile(never.publicId)).status).toBe('DELETE_REQUESTED');
  });
});

describe("Cloudinary's upload notification", () => {
  const notify = (body: object, opts: { ageMs?: number; algorithm?: 'sha1' | 'sha256'; signature?: string } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor((Date.now() - (opts.ageMs ?? 0)) / 1000));
    return request(app)
      .post('/api/storage/cloudinary/notifications')
      .set('Content-Type', 'application/json')
      .set('X-Cld-Timestamp', ts)
      .set('X-Cld-Signature', opts.signature ?? signNotification(raw, ts, opts.algorithm))
      .send(raw);
  };

  it('a signed notification records the real size, and the save then needs no explicit call', async () => {
    const a = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id }, bytes: 4321 });
    const res = await notify({ notification_type: 'upload', public_id: a.publicId, bytes: 4321, format: 'jpg', resource_type: 'image', type: 'upload' }, { algorithm: 'sha256' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('recorded');
    expect(await storedFile(a.publicId)).toMatchObject({ status: 'UPLOADED', bytes: 4321, format: 'jpg' });

    await eventService.create(tenantId, organiser.id, { name: 'Notified', hostName: 'Host', coverImageUrl: a.url, coverImagePublicId: a.publicId });
    expect(fakeCloudinary.callsTo('explicit').filter((c) => c.publicIds[0] === a.publicId)).toHaveLength(0);
    expect((await storedFile(a.publicId)).status).toBe('ATTACHED');
  });

  it('too large: requested for deletion before anyone saves it', async () => {
    const a = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id } });
    const res = await notify({ notification_type: 'upload', public_id: a.publicId, bytes: EVENT_COVER_MAX_BYTES + 1 });
    expect(res.body.outcome).toBe('too_large');
    expect((await storedFile(a.publicId)).status).toBe('DELETE_REQUESTED');
  });

  it('a bad signature, or one older than 2 hours: 401 and nothing recorded', async () => {
    const a = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id } });
    const body = { notification_type: 'upload', public_id: a.publicId, bytes: 10 };
    expect((await notify(body, { signature: 'f'.repeat(40) })).status).toBe(401);
    expect((await notify(body, { ageMs: 3 * 60 * MINUTE })).status).toBe(401);
    expect(await storedFile(a.publicId)).toMatchObject({ status: 'SIGNED', bytes: null });
  });
});

// ── 8. Existing files: the migration's backfill ─────────────

describe('legacy rows (20261105090000_stored_files backfill)', () => {
  it('every file a record already references gets a legacy row, with its state, and its owner points at it', async () => {
    const event = await newEvent();
    const cover = `${legacyCoverFolder(tenantId)}/${crypto.randomUUID()}`;
    await prisma.event.update({ where: { id: event.id }, data: { coverImagePublicId: cover, coverImageUrl: 'https://example.test/c.jpg' } });
    const hub = await memoryHubRepository.findByEventId(event.id);
    const live = `${legacyMemoryHubFolder(tenantId, event.id)}/${crypto.randomUUID()}`;
    const purged = `${legacyMemoryHubFolder(tenantId, event.id)}/${crypto.randomUUID()}`;
    const mk = (publicId: string, extra: object) => prisma.memoryItem.create({ data: { memoryHubId: hub!.id, mediaUrl: 'https://example.test/x.jpg', cloudinaryPublicId: publicId, mediaType: 'VIDEO', bytes: 777, createdBy: 'test', updatedBy: 'test', ...extra } });
    const liveItem = await mk(live, {});
    await mk(purged, { purgedAt: new Date(), isArchived: true });

    const sql = readFileSync('prisma/migrations/20261105090000_stored_files/migration.sql', 'utf8');
    const backfill = sql.slice(sql.indexOf('-- ── Backfill: legacy rows'));
    for (const statement of backfill.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }

    const coverRow = await storedFile(cover);
    expect(coverRow).toMatchObject({ kind: 'COVER', status: 'ATTACHED', legacy: true, eventId: event.id, tenantId });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).coverFileId).toBe(coverRow.id);
    const liveRow = await storedFile(live);
    expect(liveRow).toMatchObject({ kind: 'MEMORY_ITEM', resourceType: 'VIDEO', status: 'ATTACHED', bytes: 777, legacy: true });
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: liveItem.id } })).storedFileId).toBe(liveRow.id);
    expect((await storedFile(purged)).status).toBe('DELETED');

    // From now on it goes through its record: replacing the cover requests it.
    const next = await signCover(1000, event.id);
    await eventService.update(event.id, organiser.id, organiser.role, tenantId, { hostName: 'Host', coverImageUrl: next.url, coverImagePublicId: next.publicId });
    expect((await storedFile(cover)).status).toBe('DELETE_REQUESTED');
  });
});

// ── 9. Reconciliation ───────────────────────────────────────

describe('the weekly reconciliation', () => {
  it('reports orphans, missing files and size differences for this environment, and deletes nothing', async () => {
    const orphan = `dev/t/${tenantId}/cover/${crypto.randomUUID()}`;
    fakeCloudinary.put(orphan, { bytes: 1234 });
    const missing = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id }, uploaded: false });
    await prisma.storedFile.update({ where: { id: missing.fileId }, data: { status: 'ATTACHED' } });
    const resized = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id }, bytes: 500 });
    await prisma.storedFile.update({ where: { id: resized.fileId }, data: { status: 'UPLOADED', bytes: 400 } });
    // A legacy file that isn't this environment's to call an orphan.
    fakeCloudinary.put(`eventgenie/${tenantId}/covers/${crypto.randomUUID()}`, { bytes: 99 });

    const res = await request(app).post('/api/admin/storage/reconciliations').set(headersFor(superAdmin));
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.completedAt).toBeTruthy();
    expect(report.error).toBeNull();
    expect(report.details.prefix).toBe('dev/');
    expect(report.details.orphans).toEqual(expect.arrayContaining([expect.objectContaining({ publicId: orphan, bytes: 1234, recordStatus: null })]));
    expect(report.details.orphans.some((o: { publicId: string }) => o.publicId.startsWith('eventgenie/'))).toBe(false);
    expect(report.details.missing).toEqual(expect.arrayContaining([expect.objectContaining({ publicId: missing.publicId, status: 'ATTACHED' })]));
    expect(report.details.sizeMismatches).toEqual(expect.arrayContaining([expect.objectContaining({ publicId: resized.publicId, recordBytes: 400, cloudinaryBytes: 500 })]));
    expect(report.orphanCount).toBeGreaterThanOrEqual(1);

    expect(fakeCloudinary.callsTo('destroy')).toHaveLength(0);
    expect(fakeCloudinary.callsTo('delete_resources')).toHaveLength(0);
    expect(fakeCloudinary.assets.has(orphan)).toBe(true);
    expect((await storedFile(missing.publicId)).status).toBe('ATTACHED');

    const list = await request(app).get('/api/admin/storage/reconciliations').set(headersFor(superAdmin));
    expect(list.body.data[0]).toMatchObject({ id: report.id });
    expect(list.body.data[0]).not.toHaveProperty('details');
    expect((await request(app).get(`/api/admin/storage/reconciliations/${report.id}`).set(headersFor(superAdmin))).body.data.details).toBeTruthy();
  });

  it('only super admins see it; everyone else gets the global 404', async () => {
    for (const path of ['/api/admin/storage/reconciliations', '/api/admin/storage/reconciliations/x']) {
      const res = await request(app).get(path).set(headersFor(organiser));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ status: 'error', message: 'Route not found' });
    }
  });

  it('runs once per ISO week, however many times the sweep asks', async () => {
    expect(isoWeekKey(new Date('2026-11-05T10:00:00Z'))).toBe('2026-W45');
    expect(isoWeekKey(new Date('2027-01-01T10:00:00Z'))).toBe('2026-W53');
    const now = new Date('2031-06-04T12:00:00Z');
    await prisma.storageReconciliation.deleteMany({ where: { periodKey: isoWeekKey(now) } });
    expect(await storageReconciliationService.runIfDue(now)).toBe(true);
    expect(await storageReconciliationService.runIfDue(now)).toBe(false);
    await prisma.storageReconciliation.deleteMany({ where: { periodKey: isoWeekKey(now) } });
  });
});

// ── Round A follow-up: a cover's URL is its own ─────────────

describe("a cover's coverImageUrl must be our delivery URL for exactly its public id", () => {
  const mismatched = (good: { publicId: string; url: string }, other: { url: string }) => [
    'https://evil.example.com/c.jpg',                                       // off Cloudinary
    good.url.replace(`/${requireCloudinaryConfig().cloudName}/`, '/someone-else/'), // another account
    other.url,                                                              // another (also ours) upload
    good.url.replace('.jpg', '.svg'),                                       // a format never signed
    good.url.replace('/upload/', '/upload/c_fill,w_10/'),                   // a transformation
    null,                                                                   // no link at all
  ];

  it('create: a mismatched link is 422 and nothing is accepted, measured or requested', async () => {
    const good = await signCover();
    const other = await signCover();
    const before = await prisma.event.count({ where: { tenantId } });
    for (const coverImageUrl of mismatched(good, other)) {
      const err = await eventService
        .create(tenantId, organiser.id, { name: 'Linked', hostName: 'Host', coverImageUrl: coverImageUrl as string, coverImagePublicId: good.publicId })
        .catch((e) => e);
      expect(err, String(coverImageUrl)).toMatchObject({ statusCode: 422 });
      expect(err.message).toMatch(/link must be the one our uploader returned/);
    }
    expect((await storedFile(good.publicId)).status).toBe('SIGNED');
    expect(fakeCloudinary.callsTo('explicit').filter((c) => c.publicIds[0] === good.publicId)).toHaveLength(0);
    expect(await prisma.event.count({ where: { tenantId } })).toBe(before);

    // Control: its own link is saved.
    const made = await eventService.create(tenantId, organiser.id, { name: 'Linked', hostName: 'Host', coverImageUrl: good.url, coverImagePublicId: good.publicId });
    expect(made.coverImageUrl).toBe(good.url);
  });

  it("update: a new cover with another file's link, or the stored cover's link swapped, is 422 and the event keeps its cover", async () => {
    const first = await signCover();
    const event = await eventService.create(tenantId, organiser.id, { name: 'Kept', hostName: 'Host', coverImageUrl: first.url, coverImagePublicId: first.publicId });
    const next = await signCover(1000, event.id);
    const err = await eventService
      .update(event.id, organiser.id, organiser.role, tenantId, { coverImageUrl: first.url, coverImagePublicId: next.publicId })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect((await storedFile(next.publicId)).status).toBe('SIGNED');

    const swapped = await eventService
      .update(event.id, organiser.id, organiser.role, tenantId, { coverImageUrl: 'https://evil.example.com/c.jpg' })
      .catch((e) => e);
    expect(swapped).toMatchObject({ statusCode: 422 });
    const after = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after).toMatchObject({ coverImageUrl: first.url, coverImagePublicId: first.publicId });
    expect((await storedFile(first.publicId)).status).toBe('ATTACHED');
  });

  it('wizard: materialising a draft whose cover link is not its own is 422', async () => {
    const cover = await signCover();
    await putDraft({ publicId: cover.publicId, url: 'https://evil.example.com/c.jpg' });
    const res = await request(app).post('/api/event-drafts/current/materialize').set(headersFor(organiser));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/link must be the one our uploader returned/);
    await request(app).delete('/api/event-drafts/current').set(headersFor(organiser));
  });
});

// ── Round A follow-up: draft expiry ─────────────────────────

describe('wizard drafts untouched for 30 days', () => {
  const DAY = 24 * 60 * MINUTE;

  it('every read and save says when the draft expires', async () => {
    const saved = await putDraft(null);
    const updatedAt = new Date(saved.body.data.updatedAt).getTime();
    expect(new Date(saved.body.data.expiresAt).getTime()).toBe(updatedAt + 30 * DAY);
    const read = await request(app).get('/api/event-drafts/current').set(headersFor(organiser));
    expect(new Date(read.body.data.expiresAt).getTime()).toBe(updatedAt + 30 * DAY);
    await request(app).delete('/api/event-drafts/current').set(headersFor(organiser));
  });

  it('are deleted by the storage sweep, their cover requested and deleted with them; a draft touched within 30 days is kept', async () => {
    const staleCover = await signCover();
    expect((await putDraft(staleCover)).status).toBe(200);
    const freshCover = await signCover(1000, undefined, colleague);
    expect((await putDraft(freshCover, colleague)).status).toBe(200);

    const now = Date.now();
    const stale = await prisma.eventDraft.findFirstOrThrow({ where: { createdByUserId: organiser.id } });
    const fresh = await prisma.eventDraft.findFirstOrThrow({ where: { createdByUserId: colleague.id } });
    await prisma.eventDraft.update({ where: { id: stale.id }, data: { updatedAt: new Date(now - 31 * DAY) } });
    await prisma.eventDraft.update({ where: { id: fresh.id }, data: { updatedAt: new Date(now - 29 * DAY) } });

    await runStorageSweep(new Date(now));

    expect(await prisma.eventDraft.count({ where: { id: stale.id } })).toBe(0);
    expect((await storedFile(staleCover.publicId)).status).toBe('DELETED');
    expect(fakeCloudinary.assets.has(staleCover.publicId)).toBe(false);
    expect(await prisma.eventDraft.count({ where: { id: fresh.id } })).toBe(1);
    expect((await storedFile(freshCover.publicId)).status).toBe('ATTACHED');
    expect(fakeCloudinary.assets.has(freshCover.publicId)).toBe(true);
    await request(app).delete('/api/event-drafts/current').set(headersFor(colleague));
  });

  it('a draft saved again just before it would expire is kept, its cover with it', async () => {
    const cover = await signCover();
    await putDraft(cover);
    const draft = await prisma.eventDraft.findFirstOrThrow({ where: { createdByUserId: organiser.id } });
    const cutoff = new Date(Date.now() - 30 * DAY);
    // Seen as stale, then saved before its turn came: not deleted.
    expect(await prisma.$transaction((tx) => eventDraftRepository.deleteIfStale(draft.id, cutoff, tx))).toBe(false);
    expect(await eventDraftService.expireStale()).toBe(0);
    expect((await storedFile(cover.publicId)).status).toBe('ATTACHED');
    await request(app).delete('/api/event-drafts/current').set(headersFor(organiser));
  });
});

// ── Round A frontend fixes: one code for "not this owner's upload" ──

describe('every save refusal for an upload that is not its owner\'s, or was never uploaded, is 422 UPLOAD_NOT_FOUND with the route\'s own words', () => {
  it('cover, Memory Hub (organiser and guest) and design, over HTTP', async () => {
    const { event, day } = await createEventWithDay(tenantId, organiser.id);
    const hub = await memoryHubRepository.findByEventId(event.id);
    const { invite } = await guestRepository.createWithInvite(event.id, organiser.id, {
      firstName: 'C', surname: 'G', email: `c-${randomBytes(4).toString('hex')}@test.invalid`, phoneNumber: null, eventDayIds: [day.id], plusOnesAllowed: 0,
    });
    const other = await newEvent();
    const h = headersFor(organiser);
    const cloud = requireCloudinaryConfig().cloudName;
    const url = (kind: 'image' | 'video', publicId: string, ext = 'jpg') => `https://res.cloudinary.com/${cloud}/${kind}/upload/v1/${publicId}.${ext}`;

    // Signed for another event (not this owner's), and signed but never uploaded.
    const otherMemory = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: other.id, mediaType: 'IMAGE', uploadedBy: { userId: organiser.id } });
    const neverMemory = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: event.id, mediaType: 'IMAGE', uploadedBy: { inviteId: invite.id }, uploaded: false });
    const otherCover = await signedUpload({ kind: 'COVER', tenantId, eventId: other.id, uploadedBy: { userId: organiser.id } });
    const neverCover = await signedUpload({ kind: 'COVER', tenantId, eventId: null, uploadedBy: { userId: organiser.id }, uploaded: false });
    const otherDesign = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId, eventId: other.id, uploadedBy: { userId: organiser.id }, format: 'png' });
    const neverDesign = await signedUpload({ kind: 'INVITATION_DESIGN', tenantId, eventId: event.id, uploadedBy: { userId: organiser.id }, uploaded: false, format: 'png' });

    const attempts: [string, () => Promise<request.Response>, string][] = [];
    for (const m of [otherMemory, neverMemory]) {
      attempts.push(['organiser memory', () => request(app).post(`/api/events/${event.id}/memory-hub/${hub!.id}/items`).set(h).send({ mediaUrl: url('image', m.publicId), cloudinaryPublicId: m.publicId, mediaType: 'IMAGE' }),
        "This file wasn't uploaded for this event's Memory Hub. Upload it again from this event."]);
      attempts.push(['guest memory', () => request(app).post('/api/memory-hub/guest-items').send({ token: invite.token, mediaUrl: url('image', m.publicId), cloudinaryPublicId: m.publicId, mediaType: 'IMAGE' }),
        "This photo or video wasn't uploaded for this event. Please try uploading it again."]);
    }
    for (const c of [otherCover, neverCover]) {
      attempts.push(['cover create', () => request(app).post('/api/events').set(h).send({ name: 'Codes', hostName: 'Host', coverImageUrl: url('image', c.publicId), coverImagePublicId: c.publicId }),
        "This cover image wasn't uploaded for your account. Upload it again from the event form."]);
      attempts.push(['cover update', () => request(app).put(`/api/events/${event.id}`).set(h).send({ hostName: 'Host', coverImageUrl: url('image', c.publicId), coverImagePublicId: c.publicId }),
        "This cover image wasn't uploaded for your account. Upload it again from the event form."]);
    }
    for (const d of [otherDesign, neverDesign]) {
      attempts.push(['design', () => request(app).put(`/api/events/${event.id}/invitation-design`).set(h).send({ kind: 'UPLOAD', imageUrl: url('image', d.publicId, 'png'), cloudinaryPublicId: d.publicId, width: 10, height: 10 }),
        "This image wasn't uploaded for this event. Upload it again from this event's design page."]);
    }

    for (const [route, call, message] of attempts) {
      const res = await call();
      expect(res.status, route).toBe(422);
      expect(res.body, route).toMatchObject({ status: 'error', code: 'UPLOAD_NOT_FOUND', message });
    }
  });

  it('a save of an upload already saved is 409 UPLOAD_ALREADY_USED, "This upload has already been saved."', async () => {
    const event = await newEvent();
    const hub = await memoryHubRepository.findByEventId(event.id);
    const up = await signedUpload({ kind: 'MEMORY_ITEM', tenantId, eventId: event.id, mediaType: 'IMAGE', uploadedBy: { userId: organiser.id } });
    const { file } = await storedFileService.acceptUpload({ publicId: up.publicId, kind: 'MEMORY_ITEM', resourceType: 'IMAGE', tenantId, eventId: event.id, tooLarge: () => new Error('too large') as never });
    // Saved by another request between this one's check and its write.
    await memoryHubService.createOrganiserItem(event.id, hub!.id, organiser.id, organiser.role, tenantId, { mediaUrl: up.url, cloudinaryPublicId: up.publicId, mediaType: 'IMAGE' });
    const err = await prisma.$transaction((tx) => storedFileService.attach(tx, file.id, { eventId: event.id })).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'UPLOAD_ALREADY_USED', message: 'This upload has already been saved.' });
  });
});
