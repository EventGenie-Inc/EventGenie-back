import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import request from 'supertest';
import { type SubscriptionTier, type SubscriptionTierConfig } from '@prisma/client';

// ─────────────────────────────────────────
//  STORAGE RULES, ROUND B (STEERING "Storage")
//
//  1. Rejected and removed Memory Hub items deleted 7 days later, unless
//     approved or restored first; after the claim, 409 MEMORY_ITEM_DELETED.
//  2. Guests' documents: their own allowance (never the Memory Hub's), the
//     plan's size per document, the event's storage refused under its lock.
//  3. Archived guests', invites' and questions' documents kept until the
//     event finishes, then deleted; restored before, kept.
//  4. A cancelled event's documents deleted 30 days after cancelling, the
//     organisers emailed a week before.
//  5. A finished event's documents deleted 90 days after the finish, the
//     organisers emailed a week before.
//  6. Everything through the storage worker (the fake Cloudinary's single
//     destroy), and nothing at all with storageRetention off.
//
//  The sweep keeps a record of its last run and its last resume
//  (retention-state.util.ts): no deletion until 7 days after a resume. Every
//  test but the last runs as if the sweep had been running all along
//  (`runningAllAlong`, and `sweep` records each run just before it), so
//  only the last one sees a resume.
//
//  Cloudinary is the fake (tests/helpers/fake-cloudinary.ts): documents are
//  "uploaded" to it and every delete is its destroy. Every sweep runs over
//  the whole test database, so each assertion looks at this suite's own
//  events only.
// ─────────────────────────────────────────

import app from '../../src/app.js';
import { createActor, createTenant, createEventWithDay, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { addPhoto, cleanupTenants, newEvent as newHubEvent, type TestEvent } from '../feedback/helpers.js';
import { fakeCloudinary } from '../helpers/fake-cloudinary.js';
import { clearSentEmails, sentEmails } from '../helpers/sent-emails.js';
import { guestRepository } from '../../src/modules/guest/guest.repository.js';
import { storedFileService } from '../../src/modules/storage/stored-file.service.js';
import { storageRetentionService } from '../../src/modules/storage-retention/storage-retention.service.js';
import { RETENTION_RESUME_GAP_MS } from '../../src/modules/storage-retention/retention-state.util.js';
import { storageRetentionRepository } from '../../src/modules/storage-retention/storage-retention.repository.js';
import { guestsTabLink } from '../../src/modules/storage-retention/document-purge-reminder-email.util.js';
import { subscriptionTierConfigRepository } from '../../src/modules/subscription-tier-config/subscription-tier-config.repository.js';
import { DOCUMENT_STORAGE_FULL_MESSAGE } from '../../src/modules/guest-document/guest-document-allowance.util.js';
import { LAUNCH_CONTACT_EMAIL } from '../../src/modules/subscription-tier-config/tier-refusal-wording.util.js';
import { EMAIL_LAYOUT_MARKER } from '../../src/shared/messaging/email-layout.js';
import { formatGuestDate } from '../../src/shared/utils/guest-date.util.js';

vi.setConfig({ testTimeout: 120_000 });

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
const MB = 1024 * 1024;
const BASE = 'https://app.example.test';

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;
let superAdmin: Actor;

// The plan's document settings (and Memory Hub, for its detail) as a test
// sets them, laid over the real tier row through findByTier: the shared
// tier rows are never written for it.
let planOverride: Partial<Awaited<ReturnType<typeof subscriptionTierConfigRepository.findByTier>>> | null = null;
const realFindByTier = subscriptionTierConfigRepository.findByTier;

beforeAll(async () => {
  const tenant = await createTenant(); // ELEVATE
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  superAdmin = await createActor('SUPER_ADMIN', null);
}, 60_000);

// The sweep has been running with the flag on for a month.
const STATE = { id: 'singleton' };
const runningAllAlong = (now = new Date()) =>
  prisma.storageRetentionState.upsert({
    where: STATE,
    create: { ...STATE, lastSweptAt: new Date(now.getTime() - MINUTE), resumedAt: new Date(now.getTime() - 30 * DAY_MS) },
    update: { lastSweptAt: new Date(now.getTime() - MINUTE), resumedAt: new Date(now.getTime() - 30 * DAY_MS) },
  });

// One sweep at `now`, as if the previous one ran a minute earlier (a sweep
// at a future `now` mustn't look like a gap).
const sweep = async (now: Date = new Date()) => {
  await runningAllAlong(now);
  return storageRetentionService.sweep(now);
};

beforeEach(async () => {
  await runningAllAlong();
  installFirebaseMock();
  vi.stubEnv('FRONTEND_BASE_URL', BASE);
  clearSentEmails();
  planOverride = null;
  vi.spyOn(subscriptionTierConfigRepository, 'findByTier').mockImplementation(async (tier: SubscriptionTier) => {
    const config = await realFindByTier(tier);
    return config && planOverride ? { ...config, ...planOverride } : config;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  await cleanupTenants(tenantIds.splice(0));
}, 120_000);

// ── Fixtures ──────────────────────────────

const pdf = (size = 400): Buffer => Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(Math.max(0, size - 16)), Buffer.from('\n%%EOF\n')]);
const PDF = pdf();

interface DocEvent {
  eventId: string;
  dayId: string;
  fieldId: string;
}

// A published event a few months ahead (open to replies) with a DOCUMENT question.
const docEvent = async (opts: { visibility?: 'PUBLIC' } = {}): Promise<DocEvent & { shareToken: string | null }> => {
  const { event, day } = await createEventWithDay(tenantId, organiser.id);
  const shareToken = opts.visibility ? randomBytes(32).toString('hex') : null;
  if (shareToken) await prisma.event.update({ where: { id: event.id }, data: { visibility: 'PUBLIC', shareToken } });
  const field = await prisma.rsvpField.create({
    data: { eventId: event.id, label: 'Proof of payment', fieldType: 'DOCUMENT', isRequired: false, order: 0, createdBy: organiser.id, updatedBy: organiser.id },
  });
  return { eventId: event.id, dayId: day.id, fieldId: field.id, shareToken };
};

const newGuest = async (setup: DocEvent) => {
  const { guest, invite } = await guestRepository.createWithInvite(setup.eventId, organiser.id, {
    firstName: 'Thandi',
    surname: 'Nkosi',
    email: `guest-${randomBytes(6).toString('hex')}@test.invalid`,
    phoneNumber: null,
    eventDayIds: [setup.dayId],
    plusOnesAllowed: 0,
  });
  return { guestId: guest.id, inviteId: invite.id, token: invite.token };
};

const uploadAsGuest = (token: string, fieldId: string, file: Buffer = PDF) =>
  request(app).post('/api/rsvp/documents').field('token', token).field('rsvpFieldId', fieldId).attach('file', file, 'Proof of payment.pdf');

// A guest who replied with a document.
const received = async (setup: DocEvent, file: Buffer = PDF) => {
  const guest = await newGuest(setup);
  const upload = await uploadAsGuest(guest.token, setup.fieldId, file);
  expect(upload.status).toBe(201);
  const reply = await request(app).post('/api/rsvp/submit').send({
    token: guest.token,
    attending: true,
    attendingDayIds: [setup.dayId],
    rsvpResponses: [{ rsvpFieldId: setup.fieldId, value: upload.body.data.id }],
  });
  expect(reply.status).toBe(200);
  return { ...guest, documentId: upload.body.data.id as string };
};

const documentRow = (id: string) => prisma.guestDocument.findUniqueOrThrow({ where: { id } });
const isDeleted = async (id: string) => (await documentRow(id)).deletedAt !== null;
const destroyed = (publicId: string) => fakeCloudinary.destroyedIds().includes(publicId);

// The event's last day ended `ms` ago (in the past) or ends in `-ms`.
const finishedAgo = async (setup: DocEvent, ms: number) => {
  const end = new Date(Date.now() - ms);
  const date = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  await prisma.eventDay.update({ where: { id: setup.dayId }, data: { date, endTime: end } });
};

const cancelledAgo = (setup: DocEvent, ms: number) =>
  prisma.event.update({ where: { id: setup.eventId }, data: { status: 'CANCELLED', cancelledAt: new Date(Date.now() - ms) } });

const remindedAgo = (eventId: string, reason: 'FINISHED' | 'CANCELLED', ms: number) =>
  prisma.documentPurgeReminderClaim.update({ where: { eventId_reason: { eventId, reason } }, data: { claimedAt: new Date(Date.now() - ms) } });

const remindersFor = (eventId: string) => sentEmails().filter((e) => e.text.includes(guestsTabLink(eventId)));

// ── Memory Hub fixtures ───────────────────

const itemUrl = (ev: TestEvent, itemId: string) => `/api/events/${ev.event.id}/memory-hub/${ev.hubId}/items/${itemId}`;
const item = (id: string) => prisma.memoryItem.findUniqueOrThrow({ where: { id } });
const itemFile = async (id: string) => {
  const { storedFileId } = await item(id);
  return storedFileId ? prisma.storedFile.findUniqueOrThrow({ where: { id: storedFileId } }) : null;
};

// ══════════════════════════════════════════
//  1. Rejected and removed Memory Hub items
// ══════════════════════════════════════════

describe('rejected and removed Memory Hub items', () => {
  it('a rejected photo is deleted 7 days after it was rejected, not after 6; the answer carries deletesAt', async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const photo = await addPhoto(ev, { status: 'PENDING' });
    fakeCloudinary.put(photo.cloudinaryPublicId, { bytes: 1024 });

    const before = Date.now();
    const res = await request(app).post(`${itemUrl(ev, photo.id)}/reject`).set(headersFor(organiser));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REJECTED');
    const deletesAt = new Date(res.body.data.deletesAt).getTime();
    expect(deletesAt).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 1000);
    expect(deletesAt).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 1000);

    await prisma.memoryItem.update({ where: { id: photo.id }, data: { rejectedAt: new Date(Date.now() - 6 * DAY_MS) } });
    await sweep();
    expect((await item(photo.id)).purgedAt).toBeNull();
    expect(destroyed(photo.cloudinaryPublicId)).toBe(false);

    await prisma.memoryItem.update({ where: { id: photo.id }, data: { rejectedAt: new Date(Date.now() - 7 * DAY_MS - MINUTE) } });
    const result = await sweep();
    expect(result.itemsClaimed).toBeGreaterThanOrEqual(1);
    const after = await item(photo.id);
    expect(after.purgedAt).not.toBeNull();
    expect(after.isArchived).toBe(true);
    // Through the worker: its StoredFile, and the file with its CDN copy.
    expect((await itemFile(photo.id))!.status).toBe('DELETED');
    expect(destroyed(photo.cloudinaryPublicId)).toBe(true);
    expect(fakeCloudinary.callsTo('destroy').find((c) => c.publicIds[0] === photo.cloudinaryPublicId)!.params['invalidate']).toBe('true');
    expect(fakeCloudinary.assets.has(photo.cloudinaryPublicId)).toBe(false);
  });

  it('approving on day 6 keeps it, and clears its countdown', async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const photo = await addPhoto(ev, { status: 'PENDING' });
    expect((await request(app).post(`${itemUrl(ev, photo.id)}/reject`).set(headersFor(organiser))).status).toBe(200);
    await prisma.memoryItem.update({ where: { id: photo.id }, data: { rejectedAt: new Date(Date.now() - 6 * DAY_MS) } });

    const approve = await request(app).post(`${itemUrl(ev, photo.id)}/approve`).set(headersFor(organiser));
    expect(approve.status).toBe(200);
    expect(approve.body.data).toMatchObject({ status: 'APPROVED', deletesAt: null });
    expect((await item(photo.id)).rejectedAt).toBeNull();

    // Long past the 7 days: still kept.
    await sweep(new Date(Date.now() + 30 * DAY_MS));
    expect(await item(photo.id)).toMatchObject({ purgedAt: null, isArchived: false, status: 'APPROVED' });
    expect(destroyed(photo.cloudinaryPublicId)).toBe(false);
  });

  it('a removed photo is deleted 7 days after removing; one restored on day 6 is kept; the removed list shows the countdown', async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const gone = await addPhoto(ev);
    const restored = await addPhoto(ev);

    for (const p of [gone, restored]) {
      const res = await request(app).delete(itemUrl(ev, p.id)).set(headersFor(organiser));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: p.id, isArchived: true });
      expect(res.body.data.deletesAt).not.toBeNull();
    }
    const removed = await request(app).get(`/api/events/${ev.event.id}/memory-hub/${ev.hubId}/items?removed=true`).set(headersFor(organiser));
    expect(removed.status).toBe(200);
    expect(removed.body.data.map((i: { id: string }) => i.id).sort()).toEqual([gone.id, restored.id].sort());
    expect(removed.body.data.every((i: { deletesAt: string | null }) => i.deletesAt !== null)).toBe(true);
    const live = await request(app).get(`/api/events/${ev.event.id}/memory-hub/${ev.hubId}/items`).set(headersFor(organiser));
    expect(live.body.data).toEqual([]);

    await prisma.memoryItem.updateMany({ where: { id: { in: [gone.id, restored.id] } }, data: { removedAt: new Date(Date.now() - 6 * DAY_MS) } });
    const restore = await request(app).post(`${itemUrl(ev, restored.id)}/reactivate`).set(headersFor(organiser));
    expect(restore.status).toBe(200);
    expect(restore.body.data).toMatchObject({ isArchived: false, deletesAt: null });

    await prisma.memoryItem.update({ where: { id: gone.id }, data: { removedAt: new Date(Date.now() - 7 * DAY_MS - MINUTE) } });
    await sweep(new Date(Date.now() + MINUTE));
    expect((await item(gone.id)).purgedAt).not.toBeNull();
    expect(destroyed(gone.cloudinaryPublicId)).toBe(true);
    expect(await item(restored.id)).toMatchObject({ purgedAt: null, isArchived: false, removedAt: null });
    expect(destroyed(restored.cloudinaryPublicId)).toBe(false);

    // A deleted item leaves the removed list.
    const after = await request(app).get(`/api/events/${ev.event.id}/memory-hub/${ev.hubId}/items?removed=true`).set(headersFor(organiser));
    expect(after.body.data).toEqual([]);
  });

  it('once its deletion is claimed, approving or restoring is 409 MEMORY_ITEM_DELETED, and nothing changes', async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const rejected = await addPhoto(ev, { status: 'PENDING' });
    const removed = await addPhoto(ev);
    expect((await request(app).post(`${itemUrl(ev, rejected.id)}/reject`).set(headersFor(organiser))).status).toBe(200);
    expect((await request(app).delete(itemUrl(ev, removed.id)).set(headersFor(organiser))).status).toBe(200);
    await prisma.memoryItem.update({ where: { id: rejected.id }, data: { rejectedAt: new Date(Date.now() - 8 * DAY_MS) } });
    await prisma.memoryItem.update({ where: { id: removed.id }, data: { removedAt: new Date(Date.now() - 8 * DAY_MS) } });
    await sweep();

    const approve = await request(app).post(`${itemUrl(ev, rejected.id)}/approve`).set(headersFor(organiser));
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('MEMORY_ITEM_DELETED');
    const restore = await request(app).post(`${itemUrl(ev, removed.id)}/reactivate`).set(headersFor(organiser));
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe('MEMORY_ITEM_DELETED');
    expect(await item(rejected.id)).toMatchObject({ status: 'REJECTED', isArchived: true });
    expect(await item(removed.id)).toMatchObject({ isArchived: true });
    expect((await item(removed.id)).purgedAt).not.toBeNull();
  });

  it('approving while a sweep claims the item: approved and kept, or refused and deleted, never both', async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const photos = await Promise.all([1, 2, 3, 4].map(() => addPhoto(ev, { status: 'REJECTED' })));
    await prisma.memoryItem.updateMany({ where: { id: { in: photos.map((p) => p.id) } }, data: { rejectedAt: new Date(Date.now() - 8 * DAY_MS) } });

    const [approvals] = await Promise.all([
      Promise.all(photos.map((p) => request(app).post(`${itemUrl(ev, p.id)}/approve`).set(headersFor(organiser)))),
      sweep(),
    ]);
    for (const [i, p] of photos.entries()) {
      const row = await item(p.id);
      const file = await itemFile(p.id);
      if (approvals[i]!.status === 200) {
        expect(row).toMatchObject({ status: 'APPROVED', purgedAt: null, isArchived: false });
        expect(file?.status ?? 'none').not.toMatch(/DELETE/);
      } else {
        expect(approvals[i]!.status).toBe(409);
        expect(row.purgedAt).not.toBeNull();
        expect(row.status).toBe('REJECTED');
      }
    }
  });

  it("items rejected or removed before this release get the migration's time: nothing is deleted at deploy", async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const rejected = await addPhoto(ev, { status: 'REJECTED' });
    const removed = await addPhoto(ev, { isArchived: true });
    // As the code before the columns left them, long ago.
    await prisma.memoryItem.updateMany({ where: { id: { in: [rejected.id, removed.id] } }, data: { rejectedAt: null, removedAt: null, updatedAt: new Date(Date.now() - 400 * DAY_MS) } });

    const before = Date.now();
    for (const statement of backfillStatements(/"MemoryItem"/)) await prisma.$executeRawUnsafe(statement);
    for (const [id, column] of [[rejected.id, 'rejectedAt'], [removed.id, 'removedAt']] as const) {
      const at = (await item(id))[column]!.getTime();
      expect(at).toBeGreaterThanOrEqual(before - MINUTE);
      expect(at).toBeLessThanOrEqual(Date.now() + MINUTE);
    }

    await sweep();
    expect((await item(rejected.id)).purgedAt).toBeNull();
    expect((await item(removed.id)).purgedAt).toBeNull();
  });
});

// The migration's backfill UPDATEs whose text matches `table`.
const backfillStatements = (table: RegExp): string[] =>
  readFileSync('prisma/migrations/20261106090000_storage_rules/migration.sql', 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('UPDATE') && table.test(s));

// ══════════════════════════════════════════
//  2. The document allowance
// ══════════════════════════════════════════

describe('the document allowance', () => {
  it("documents no longer count towards the Memory Hub's storage", async () => {
    planOverride = { memoryHubEnabled: true };
    const setup = await docEvent();
    const hubBefore = await request(app).get(`/api/events/${setup.eventId}/memory-hub`).set(headersFor(organiser));
    expect(hubBefore.status).toBe(200);

    await received(setup);

    const hubAfter = await request(app).get(`/api/events/${setup.eventId}/memory-hub`).set(headersFor(organiser));
    expect(hubAfter.body.data.usedBytes).toBe(hubBefore.body.data.usedBytes);
    const detail = await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser));
    expect(detail.body.data.documentStorage.usedBytes).toBe(PDF.length);
  });

  it("an upload over the event's document storage is refused, 403 DOCUMENT_STORAGE_FULL in words a guest can read, storing nothing", async () => {
    const setup = await docEvent();
    planOverride = { maxDocumentBytesPerEvent: Math.floor(PDF.length * 1.5) };
    await received(setup);
    const uploadsBefore = fakeCloudinary.callsTo('upload').length;

    const guest = await newGuest(setup);
    const res = await uploadAsGuest(guest.token, setup.fieldId);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: 'error', message: DOCUMENT_STORAGE_FULL_MESSAGE, code: 'DOCUMENT_STORAGE_FULL' });
    expect(res.body.message).not.toMatch(/plan|upgrade|MB|trial/i);
    expect(fakeCloudinary.callsTo('upload').length).toBe(uploadsBefore);
    expect(await prisma.guestDocument.count({ where: { eventId: setup.eventId } })).toBe(1);
  });

  it('two uploads racing for the last space: one is stored, the other refused under the lock and its file requested for deletion', async () => {
    const setup = await docEvent();
    planOverride = { maxDocumentBytesPerEvent: Math.floor(PDF.length * 1.5) };
    const [a, b] = [await newGuest(setup), await newGuest(setup)];
    // Each upload's transaction held a moment after its check, so both
    // pass the check before the lock-free pre-check and overlap there:
    // only the event's row lock keeps the second from seeing 0 used.
    const realRecordMeasured = storedFileService.recordMeasured;
    vi.spyOn(storedFileService, 'recordMeasured').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return realRecordMeasured(...args);
    });

    const results = await Promise.all([uploadAsGuest(a.token, setup.fieldId), uploadAsGuest(b.token, setup.fieldId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(await prisma.guestDocument.count({ where: { eventId: setup.eventId } })).toBe(1);
    // A refused upload that reached Cloudinary is requested, never left.
    const files = await prisma.storedFile.findMany({ where: { eventId: setup.eventId, kind: 'GUEST_DOCUMENT' } });
    expect(files.filter((f) => f.status !== 'DELETE_REQUESTED' && f.status !== 'DELETED')).toHaveLength(1);
  });

  it("the size per document is the plan's: one byte over is 413 naming it; past the route's 20 MB ceiling, 413 too", async () => {
    const setup = await docEvent();
    const guest = await newGuest(setup);
    planOverride = { maxDocumentBytesPerFile: 1 * MB };

    expect((await uploadAsGuest(guest.token, setup.fieldId, pdf(1 * MB))).status).toBe(201);
    const over = await uploadAsGuest(guest.token, setup.fieldId, pdf(1 * MB + 1));
    expect(over.status).toBe(413);
    expect(over.body).toMatchObject({ code: 'DOCUMENT_TOO_LARGE', message: 'This file is larger than 1 MB. Choose a smaller file.' });

    // A plan allowing more than the ceiling is held to the ceiling.
    planOverride = { maxDocumentBytesPerFile: null };
    const huge = await uploadAsGuest(guest.token, setup.fieldId, pdf(20 * MB + 1));
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe('DOCUMENT_TOO_LARGE');
  });

  it('guests are told the size per document on /rsvp/validate and the public view; null with documentFields off', async () => {
    const setup = await docEvent({ visibility: 'PUBLIC' });
    const guest = await newGuest(setup);
    planOverride = { maxDocumentBytesPerFile: 3 * MB };

    expect((await request(app).get(`/api/rsvp/validate/${guest.token}`)).body.data.maxDocumentBytes).toBe(3 * MB);
    expect((await request(app).get(`/api/public-events/${setup.shareToken}`)).body.data.maxDocumentBytes).toBe(3 * MB);

    vi.stubEnv('FEATURES_DISABLED', 'documentFields');
    expect((await request(app).get(`/api/rsvp/validate/${guest.token}`)).body.data.maxDocumentBytes).toBeNull();
    expect((await request(app).get(`/api/public-events/${setup.shareToken}`)).body.data.maxDocumentBytes).toBeNull();
  });

  it('the organiser sees the storage used, the allowance, and a warning once past 80%', async () => {
    const setup = await docEvent();
    await received(setup);
    const detail = async () => (await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser))).body.data.documentStorage;

    planOverride = { maxDocumentBytesPerEvent: Math.ceil(PDF.length / 0.8) }; // exactly 80% used: no warning yet
    expect(await detail()).toEqual({ usedBytes: PDF.length, limitBytes: Math.ceil(PDF.length / 0.8), nearLimit: false, documentCount: 1, deletesAt: null });

    planOverride = { maxDocumentBytesPerEvent: Math.floor(PDF.length / 0.8) - 1 }; // past 80%
    expect(await detail()).toMatchObject({ usedBytes: PDF.length, nearLimit: true });

    planOverride = { maxDocumentBytesPerEvent: null };
    expect(await detail()).toMatchObject({ limitBytes: null, nearLimit: false });

    vi.stubEnv('FEATURES_DISABLED', 'documentFields');
    const off = await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser));
    expect(off.body.data).not.toHaveProperty('documentStorage');
  });

  it('the super admin sets both, validated like the other limits; /me reports them', async () => {
    vi.restoreAllMocks(); // the real tier row, no override
    installFirebaseMock();
    const saved: SubscriptionTierConfig | null = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } });
    const put = (body: object) => request(app).put('/api/subscription-tiers/ELEVATE').set(headersFor(superAdmin)).send(body);
    try {
      for (const body of [
        { maxDocumentBytesPerFile: 20 * MB + 1 },
        { maxDocumentBytesPerFile: 0 },
        { maxDocumentBytesPerFile: 1.5 },
        { maxDocumentBytesPerEvent: -1 },
        { maxDocumentBytesPerEvent: 'lots' },
      ]) {
        const res = await put(body);
        expect(res.status).toBe(422);
      }
      expect(await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } })).toEqual(saved);

      const ok = await put({ maxDocumentBytesPerEvent: 6 * 1024 * MB, maxDocumentBytesPerFile: 2 * MB });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ maxDocumentBytesPerEvent: 6 * 1024 * MB, maxDocumentBytesPerFile: 2 * MB });
      const me = await request(app).get('/api/tenants/me').set(headersFor(organiser));
      expect(me.body.data.planSettings).toMatchObject({ maxDocumentBytesPerEvent: 6 * 1024 * MB, maxDocumentBytesPerFile: 2 * MB });

      // Blank: unlimited per event, the ceiling per document.
      expect((await put({ maxDocumentBytesPerEvent: null, maxDocumentBytesPerFile: '' })).status).toBe(200);
      const after = await request(app).get('/api/tenants/me').set(headersFor(organiser));
      expect(after.body.data.planSettings).toMatchObject({ maxDocumentBytesPerEvent: null, maxDocumentBytesPerFile: 20 * MB });
    } finally {
      if (saved) {
        const { tier: _tier, ...values } = saved;
        await prisma.subscriptionTierConfig.upsert({ where: { tier: 'ELEVATE' }, create: saved, update: values });
      }
    }
  });

  it("the migration set every tier's allowance: 500 MB per event, 5 MB per document", async () => {
    const statements = backfillStatements(/"SubscriptionTierConfig"/);
    expect(statements).toHaveLength(3);
    for (const tier of ['SPARK', 'CELEBRATE', 'ELEVATE']) {
      expect(statements.find((s) => s.includes(`'${tier}'`))).toMatch(/"maxDocumentBytesPerEvent" = 524288000, "maxDocumentBytesPerFile" = 5242880/);
    }
  });
});

// ══════════════════════════════════════════
//  3. Archived guests' documents
// ══════════════════════════════════════════

describe("archived guests' documents", () => {
  it('a guest archived and restored before the event finishes keeps their documents', async () => {
    const setup = await docEvent();
    const { guestId, documentId } = await received(setup);
    expect((await request(app).delete(`/api/guests/${guestId}`).set(headersFor(organiser))).status).toBe(200);
    expect((await request(app).post(`/api/guests/${guestId}/reactivate`).set(headersFor(organiser))).status).toBe(200);

    await finishedAgo(setup, MINUTE);
    await sweep();
    expect(await documentRow(documentId)).toMatchObject({ deleteRequestedAt: null, deletedAt: null });
  });

  it('a guest, invite or question still archived when the event finishes loses its documents then; live guests keep theirs', async () => {
    const setup = await docEvent();
    const archivedGuest = await received(setup);
    const archivedInvite = await received(setup);
    const live = await received(setup);
    const otherQuestion = await prisma.rsvpField.create({
      data: { eventId: setup.eventId, label: 'ID copy', fieldType: 'DOCUMENT', isRequired: false, order: 1, createdBy: organiser.id, updatedBy: organiser.id },
    });
    const archivedQuestion = await received({ ...setup, fieldId: otherQuestion.id });

    expect((await request(app).delete(`/api/guests/${archivedGuest.guestId}`).set(headersFor(organiser))).status).toBe(200);
    expect((await request(app).delete(`/api/events/${setup.eventId}/invites/${archivedInvite.inviteId}`).set(headersFor(organiser))).status).toBe(200);
    expect((await request(app).delete(`/api/events/${setup.eventId}/rsvp-fields/${otherQuestion.id}`).set(headersFor(organiser))).status).toBe(200);

    // Not before the finish.
    await finishedAgo(setup, -DAY_MS);
    await sweep();
    for (const doc of [archivedGuest, archivedInvite, archivedQuestion, live]) expect(await isDeleted(doc.documentId)).toBe(false);

    await finishedAgo(setup, MINUTE);
    const result = await sweep();
    expect(result.documentPurges).toContainEqual({ eventId: setup.eventId, reason: 'ARCHIVED_AT_FINISH', requestedCount: 3 });
    for (const doc of [archivedGuest, archivedInvite, archivedQuestion]) {
      expect(await isDeleted(doc.documentId)).toBe(true);
      expect(destroyed((await documentRow(doc.documentId)).cloudinaryPublicId)).toBe(true);
    }
    expect(await documentRow(live.documentId)).toMatchObject({ deleteRequestedAt: null, deletedAt: null });

    // Once: a second sweep claims nothing more.
    const again = await sweep();
    expect(again.documentPurges.filter((p) => p.eventId === setup.eventId)).toEqual([]);
  });

  it("the guest details count the guest's kept documents, for the warning before archiving", async () => {
    const setup = await docEvent();
    const { guestId } = await received(setup);
    const res = await request(app).get(`/api/guests/${guestId}`).set(headersFor(organiser));
    expect(res.status).toBe(200);
    expect(res.body.data.documentCount).toBe(1);

    const none = await newGuest(setup);
    expect((await request(app).get(`/api/guests/${none.guestId}`).set(headersFor(organiser))).body.data.documentCount).toBe(0);
  });

  it('a restore after the sweep found the event, before it claimed, keeps the documents: the claim re-checks under the lock', async () => {
    const setup = await docEvent();
    const { guestId, documentId } = await received(setup);
    expect((await request(app).delete(`/api/guests/${guestId}`).set(headersFor(organiser))).status).toBe(200);
    await finishedAgo(setup, MINUTE);

    // The sweep's read: the event is due, with an archived guest's document.
    expect(await storageRetentionRepository.findEventsDue('ARCHIVED_AT_FINISH', new Date())).toContain(setup.eventId);
    // The guest restored in between.
    expect((await request(app).post(`/api/guests/${guestId}/reactivate`).set(headersFor(organiser))).status).toBe(200);
    const outcome = await storageRetentionService.claimDocumentPurge(setup.eventId, 'ARCHIVED_AT_FINISH', new Date());

    expect(outcome).toEqual({ requestedCount: 0 });
    expect(await documentRow(documentId)).toMatchObject({ deleteRequestedAt: null, deletedAt: null });
  });
});

// ══════════════════════════════════════════
//  4. Cancelled events
// ══════════════════════════════════════════

describe('cancelled events', () => {
  it('cancelling records cancelledAt', async () => {
    const setup = await docEvent();
    const before = Date.now();
    expect((await request(app).post(`/api/events/${setup.eventId}/cancel`).set(headersFor(organiser)).send({})).status).toBe(200);
    const { cancelledAt } = await prisma.event.findUniqueOrThrow({ where: { id: setup.eventId } });
    expect(cancelledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(cancelledAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("documents survive 29 days, the organisers are emailed a week before, and all go on day 30, archived guests' included", async () => {
    const setup = await docEvent();
    const live = await received(setup);
    const archived = await received(setup);
    expect((await request(app).delete(`/api/guests/${archived.guestId}`).set(headersFor(organiser))).status).toBe(200);

    await cancelledAgo(setup, 22 * DAY_MS);
    await sweep();
    expect(remindersFor(setup.eventId)).toEqual([]);

    // Day 23: the reminder, once.
    await cancelledAgo(setup, 23 * DAY_MS + MINUTE);
    await sweep();
    await sweep();
    expect(remindersFor(setup.eventId)).toHaveLength(1);

    // Day 29, the reminder's week already over: kept (the 30 days aren't).
    await cancelledAgo(setup, 29 * DAY_MS);
    await remindedAgo(setup.eventId, 'CANCELLED', 8 * DAY_MS);
    await sweep();
    for (const doc of [live, archived]) expect(await isDeleted(doc.documentId)).toBe(false);
    const detail = await request(app).get(`/api/events/${setup.eventId}`).set(headersFor(organiser));
    expect(detail.body.data.documentStorage.deletesAt).not.toBeNull();

    // Day 30, but reminded only 6 days ago: kept until its week is over.
    await cancelledAgo(setup, 30 * DAY_MS + MINUTE);
    await remindedAgo(setup.eventId, 'CANCELLED', 6 * DAY_MS);
    await sweep();
    for (const doc of [live, archived]) expect(await isDeleted(doc.documentId)).toBe(false);

    // Day 30, a week after the reminder: every one.
    await cancelledAgo(setup, 30 * DAY_MS + MINUTE);
    await remindedAgo(setup.eventId, 'CANCELLED', 7 * DAY_MS + MINUTE);
    const result = await sweep();
    expect(result.documentPurges).toContainEqual({ eventId: setup.eventId, reason: 'CANCELLED', requestedCount: 2 });
    for (const doc of [live, archived]) expect(await isDeleted(doc.documentId)).toBe(true);
    expect(remindersFor(setup.eventId)).toHaveLength(1);
  });

  it('the reminder: to the organisers, through the layout, saying what goes and when, how to keep a copy, and to contact us', async () => {
    const creator = await createActor('TENANT_ADMIN', tenantId);
    const { event, day } = await createEventWithDay(tenantId, creator.id, 'Chess <b>club</b> dinner');
    const field = await prisma.rsvpField.create({ data: { eventId: event.id, label: 'Proof', fieldType: 'DOCUMENT', isRequired: false, order: 0, createdBy: creator.id, updatedBy: creator.id } });
    const setup = { eventId: event.id, dayId: day.id, fieldId: field.id };
    await received(setup);
    await cancelledAgo(setup, 24 * DAY_MS); // a day late: the date given is a week from the reminder

    await sweep();
    const claim = await prisma.documentPurgeReminderClaim.findUniqueOrThrow({ where: { eventId_reason: { eventId: event.id, reason: 'CANCELLED' } } });
    const date = formatGuestDate(new Date(claim.claimedAt.getTime() + 7 * DAY_MS));
    const emails = remindersFor(event.id);
    expect(emails.map((e) => e.to)).toEqual([creator.email]);
    const [email] = emails;
    expect(email!.subject).toBe(`Guest documents for Chess bclub/b dinner will be deleted on ${date}`);
    expect(email!.from).toMatch(/^"e-velope" </);
    expect(email!.html).toContain(EMAIL_LAYOUT_MARKER);
    expect(email!.html).toContain('Chess &lt;b&gt;club&lt;/b&gt; dinner');
    expect(email!.html).not.toContain('<b>club</b>');
    expect(email!.text).toContain('was cancelled');
    expect(email!.text).toContain(`permanently deleted on ${date}`);
    expect(email!.text).toContain('use View on their document to download it');
    expect(email!.text).toContain(LAUNCH_CONTACT_EMAIL);
    expect(email!.html).toContain(`href="${guestsTabLink(event.id)}"`);
  });

  it("events cancelled before this release get the migration's time: nothing is deleted or emailed at deploy", async () => {
    const setup = await docEvent();
    const doc = await received(setup);
    await prisma.event.update({ where: { id: setup.eventId }, data: { status: 'CANCELLED', cancelledAt: null, updatedAt: new Date(Date.now() - 400 * DAY_MS) } });

    const before = Date.now();
    for (const statement of backfillStatements(/"Event"/)) await prisma.$executeRawUnsafe(statement);
    const { cancelledAt } = await prisma.event.findUniqueOrThrow({ where: { id: setup.eventId } });
    expect(cancelledAt!.getTime()).toBeGreaterThanOrEqual(before - MINUTE);
    expect(cancelledAt!.getTime()).toBeLessThanOrEqual(Date.now() + MINUTE);

    await sweep();
    expect(remindersFor(setup.eventId)).toEqual([]);
    expect(await isDeleted(doc.documentId)).toBe(false);
  });
});

// ══════════════════════════════════════════
//  5. Finished events
// ══════════════════════════════════════════

describe('finished events', () => {
  it("live guests' documents survive 89 days, the organisers are emailed a week before, and go 90 days after the finish", async () => {
    const setup = await docEvent();
    const doc = await received(setup);

    await finishedAgo(setup, 83 * DAY_MS + MINUTE);
    await sweep();
    const emails = remindersFor(setup.eventId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain('has finished');
    expect(emails[0]!.text).toContain("can't be recovered");

    // Day 89, the reminder's week over: kept (the 90 days aren't).
    await finishedAgo(setup, 89 * DAY_MS);
    await remindedAgo(setup.eventId, 'FINISHED', 8 * DAY_MS);
    await sweep();
    expect(await isDeleted(doc.documentId)).toBe(false);

    // Day 90, reminded only 6 days ago: kept until its week is over.
    await finishedAgo(setup, 90 * DAY_MS + MINUTE);
    await remindedAgo(setup.eventId, 'FINISHED', 6 * DAY_MS);
    await sweep();
    expect(await isDeleted(doc.documentId)).toBe(false);

    await finishedAgo(setup, 90 * DAY_MS + MINUTE);
    await remindedAgo(setup.eventId, 'FINISHED', 7 * DAY_MS + MINUTE);
    await sweep();
    expect(await isDeleted(doc.documentId)).toBe(true);
    expect(destroyed((await documentRow(doc.documentId)).cloudinaryPublicId)).toBe(true);
  });

  it('whichever deletion comes first wins: an archived guest\'s at the finish, an event deleted before; nothing is reminded about twice or for nothing', async () => {
    const setup = await docEvent();
    const live = await received(setup);
    const archived = await received(setup);
    expect((await request(app).delete(`/api/guests/${archived.guestId}`).set(headersFor(organiser))).status).toBe(200);

    await finishedAgo(setup, 90 * DAY_MS + MINUTE);
    // The finish's own deletion first, then the reminder for what is left.
    const first = await sweep();
    expect(first.documentPurges).toContainEqual({ eventId: setup.eventId, reason: 'ARCHIVED_AT_FINISH', requestedCount: 1 });
    expect(await isDeleted(archived.documentId)).toBe(true);
    expect(await isDeleted(live.documentId)).toBe(false);
    expect(remindersFor(setup.eventId)).toHaveLength(1);

    // An event deleted (archived) before its 90 days keeps its documents
    // for its own purge (tests/guest-document/archived-event-documents.test.ts);
    // once they are gone (as if purged) there is nothing to remind anyone about.
    const deleted = await docEvent();
    const gone = await received(deleted);
    expect((await request(app).delete(`/api/events/${deleted.eventId}`).set(headersFor(organiser))).status).toBe(200);
    expect(await isDeleted(gone.documentId)).toBe(false);
    await prisma.guestDocument.update({ where: { id: gone.documentId }, data: { deleteRequestedAt: new Date(), deletedAt: new Date() } });
    await finishedAgo(deleted, 84 * DAY_MS);
    await sweep();
    expect(remindersFor(deleted.eventId)).toEqual([]);
  });
});

// ══════════════════════════════════════════
//  6. The flag
// ══════════════════════════════════════════

describe('storageRetention off', () => {
  it('deletes nothing, emails nobody and shows no countdown while off', async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const rejected = await addPhoto(ev, { status: 'PENDING' });
    expect((await request(app).post(`${itemUrl(ev, rejected.id)}/reject`).set(headersFor(organiser))).status).toBe(200);
    await prisma.memoryItem.update({ where: { id: rejected.id }, data: { rejectedAt: new Date(Date.now() - 8 * DAY_MS) } });
    const finished = await docEvent();
    const archivedGuest = await received(finished);
    expect((await request(app).delete(`/api/guests/${archivedGuest.guestId}`).set(headersFor(organiser))).status).toBe(200);
    await finishedAgo(finished, 100 * DAY_MS);
    const cancelled = await docEvent();
    const cancelledDoc = await received(cancelled);
    await cancelledAgo(cancelled, 40 * DAY_MS);

    vi.stubEnv('FEATURES_DISABLED', 'storageRetention');
    expect(await storageRetentionService.sweep()).toEqual({ skipped: true, itemsClaimed: 0, documentPurges: [], archivedEventDocuments: [], reminders: [] });
    expect((await item(rejected.id)).purgedAt).toBeNull();
    for (const doc of [archivedGuest, cancelledDoc]) expect(await isDeleted(doc.documentId)).toBe(false);
    expect(remindersFor(finished.eventId)).toEqual([]);
    expect(remindersFor(cancelled.eventId)).toEqual([]);
    const list = await request(app).get(`/api/events/${ev.event.id}/memory-hub/${ev.hubId}/items`).set(headersFor(organiser));
    expect(list.body.data.find((i: { id: string }) => i.id === rejected.id).deletesAt).toBeNull();
    const detail = await request(app).get(`/api/events/${cancelled.eventId}`).set(headersFor(organiser));
    expect(detail.body.data.documentStorage.deletesAt).toBeNull();
    // A sweep with the flag off records nothing.
    const state = await prisma.storageRetentionState.findUniqueOrThrow({ where: STATE });
    expect(Date.now() - state.lastSweptAt!.getTime()).toBeGreaterThanOrEqual(MINUTE - 1000);
  });

  it('off past the 7 days (and the 30 and 90), then on: nothing is deleted for 7 more days, and every date says so', async () => {
    const ev = await newHubEvent(tenantId, organiser.id);
    const rejected = await addPhoto(ev, { status: 'PENDING' });
    expect((await request(app).post(`${itemUrl(ev, rejected.id)}/reject`).set(headersFor(organiser))).status).toBe(200);
    await prisma.memoryItem.update({ where: { id: rejected.id }, data: { rejectedAt: new Date(Date.now() - 8 * DAY_MS) } });
    const finished = await docEvent();
    const archivedGuest = await received(finished);
    const liveGuest = await received(finished);
    expect((await request(app).delete(`/api/guests/${archivedGuest.guestId}`).set(headersFor(organiser))).status).toBe(200);
    await finishedAgo(finished, 100 * DAY_MS);
    const cancelled = await docEvent();
    const cancelledDoc = await received(cancelled);
    await cancelledAgo(cancelled, 40 * DAY_MS);

    // The flag was off for two days: the sweep's last run with it on was then.
    const offSince = new Date(Date.now() - 2 * DAY_MS);
    await prisma.storageRetentionState.update({ where: STATE, data: { lastSweptAt: offSince, resumedAt: new Date(offSince.getTime() - 30 * DAY_MS) } });

    // Back on, before the sweep has run: the countdown already says a week from now.
    const before = Date.now();
    const pending = await request(app).get(`${itemUrl(ev, rejected.id)}`).set(headersFor(organiser));
    expect(new Date(pending.body.data.deletesAt).getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 1000);

    // The first sweep records the resume and deletes nothing; the reminders
    // go, with the date a week on.
    const resumed = await storageRetentionService.sweep();
    expect(resumed.itemsClaimed).toBe(0);
    expect(resumed.documentPurges.filter((p) => [finished.eventId, cancelled.eventId].includes(p.eventId))).toEqual([]);
    const state = await prisma.storageRetentionState.findUniqueOrThrow({ where: STATE });
    const resumedAt = state.resumedAt!;
    expect(resumedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const floor = new Date(resumedAt.getTime() + 7 * DAY_MS);
    expect((await item(rejected.id)).purgedAt).toBeNull();
    for (const doc of [archivedGuest, liveGuest, cancelledDoc]) expect(await isDeleted(doc.documentId)).toBe(false);
    expect(remindersFor(finished.eventId)).toHaveLength(1);
    expect(remindersFor(cancelled.eventId)).toHaveLength(1);
    expect(remindersFor(cancelled.eventId)[0]!.subject).toContain(formatGuestDate(floor));

    const itemView = await request(app).get(`${itemUrl(ev, rejected.id)}`).set(headersFor(organiser));
    expect(itemView.body.data.deletesAt).toBe(floor.toISOString());
    const docView = await request(app).get(`/api/events/${cancelled.eventId}`).set(headersFor(organiser));
    expect(new Date(docView.body.data.documentStorage.deletesAt).getTime()).toBeGreaterThanOrEqual(floor.getTime());

    // Six days after the resume (the sweep running all along since): still nothing.
    const sixDaysOn = { lastSweptAt: new Date(Date.now() - MINUTE), resumedAt: new Date(Date.now() - 6 * DAY_MS) };
    await prisma.storageRetentionState.update({ where: STATE, data: sixDaysOn });
    await remindedAgo(finished.eventId, 'FINISHED', 6 * DAY_MS);
    await remindedAgo(cancelled.eventId, 'CANCELLED', 6 * DAY_MS);
    await storageRetentionService.sweep();
    expect((await item(rejected.id)).purgedAt).toBeNull();
    for (const doc of [archivedGuest, liveGuest, cancelledDoc]) expect(await isDeleted(doc.documentId)).toBe(false);

    // Seven days after it: everything due goes.
    await prisma.storageRetentionState.update({ where: STATE, data: { lastSweptAt: new Date(Date.now() - MINUTE), resumedAt: new Date(Date.now() - 7 * DAY_MS - MINUTE) } });
    await remindedAgo(finished.eventId, 'FINISHED', 7 * DAY_MS + MINUTE);
    await remindedAgo(cancelled.eventId, 'CANCELLED', 7 * DAY_MS + MINUTE);
    await storageRetentionService.sweep();
    expect((await item(rejected.id)).purgedAt).not.toBeNull();
    for (const doc of [archivedGuest, liveGuest, cancelledDoc]) expect(await isDeleted(doc.documentId)).toBe(true);
  });

  it('a sweep run regularly never resumes; one after a gap longer than RETENTION_RESUME_GAP_MS does', async () => {
    await prisma.storageRetentionState.update({ where: STATE, data: { lastSweptAt: new Date(Date.now() - 15 * MINUTE), resumedAt: new Date(Date.now() - 30 * DAY_MS) } });
    await storageRetentionService.sweep();
    expect((await prisma.storageRetentionState.findUniqueOrThrow({ where: STATE })).resumedAt!.getTime()).toBeLessThan(Date.now() - 29 * DAY_MS);

    await prisma.storageRetentionState.update({ where: STATE, data: { lastSweptAt: new Date(Date.now() - RETENTION_RESUME_GAP_MS - MINUTE) } });
    await storageRetentionService.sweep();
    expect((await prisma.storageRetentionState.findUniqueOrThrow({ where: STATE })).resumedAt!.getTime()).toBeGreaterThan(Date.now() - MINUTE);
  });
});
