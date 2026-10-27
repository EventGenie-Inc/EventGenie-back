import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type SubscriptionTier } from '@prisma/client';

// ─────────────────────────────────────────
//  ARCHIVED EVENTS: MEMORY HUB MEDIA DELETED AFTER 30 DAYS
//
//  30 days after an event is archived, the sweep deletes its Memory Hub
//  photos and videos from Cloudinary in batches and marks their rows purged
//  (never deleted); the event and its cover stay. Restoring first cancels
//  it; restoring after brings the event back without its media. Two sweeps
//  racing purge once; a failed deletion is retried by the next sweep. 7
//  days before, the organisers are emailed once. A super admin can purge at
//  once (everyone else: the global 404). Events archived before the release
//  start their 30 days at the migration. Restoring respects the plan's
//  event limit. The events list and views carry the dates.
//
//  destroyAssets, the one Cloudinary call a purge makes, is mocked: to see
//  what would be deleted, and so the suite never deletes anything real.
//  Each sweep runs over the whole test database, so every assertion looks
//  only at this suite's own events' folders.
// ─────────────────────────────────────────

const { mockDestroyAssets, mockDestroyAsset } = vi.hoisted(() => ({ mockDestroyAssets: vi.fn(), mockDestroyAsset: vi.fn() }));
vi.mock('../../src/shared/cloudinary/cloudinary.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/cloudinary/cloudinary.client.js')>()),
  destroyAssets: mockDestroyAssets,
  // The single delete: an upload landing on an archived event is removed.
  destroyAsset: mockDestroyAsset,
}));

import app from '../../src/app.js';
import { createActor, createTenant, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';
import { clearSentEmails, sentEmails } from '../helpers/sent-emails.js';
import {
  addPhoto,
  cleanupTenants,
  deliveryUrl,
  enableMemoryHubOnElevate,
  newEvent,
  newGuest,
  restoreElevate,
  type TestEvent,
} from '../feedback/helpers.js';
import { INACTIVE_SHARE_LINK_MESSAGE, PHOTO_ALBUM_UNAVAILABLE_MESSAGE } from '../../src/modules/memory-hub/memory-hub.service.js';
import { mediaRetentionService } from '../../src/modules/media-retention/media-retention.service.js';
import { mediaRetentionRepository } from '../../src/modules/media-retention/media-retention.repository.js';
import { subscriptionTierConfigRepository } from '../../src/modules/subscription-tier-config/subscription-tier-config.repository.js';
import { coverFolder } from '../../src/modules/upload/upload-folders.js';
import { mediaPurgeDueAt } from '../../src/modules/event/event-media-retention.util.js';
import { EVENT_NO_LONGER_AVAILABLE_MESSAGE } from '../../src/modules/rsvp/rsvp.service.js';
import { ROUTE_NOT_FOUND_BODY } from '../../src/shared/middleware/feature.middleware.js';
import { EMAIL_LAYOUT_MARKER } from '../../src/shared/messaging/email-layout.js';
import { formatGuestDate } from '../../src/shared/utils/guest-date.util.js';

vi.setConfig({ testTimeout: 120_000 });

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = 'https://app.example.test';

const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;
let eventAdmin: Actor;
let superAdmin: Actor;
let outsider: Actor;

// The plan's event limit, through the real tier row (Memory Hub on, see
// enableMemoryHubOnElevate) with only maxEvents replaced: null (unlimited)
// unless a test sets it. The shared tier rows are never written for it.
let eventLimit: number | null = null;
const realFindByTier = subscriptionTierConfigRepository.findByTier;

beforeAll(async () => {
  await enableMemoryHubOnElevate();
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  eventAdmin = await createActor('EVENT_ADMIN', tenant.id);
  superAdmin = await createActor('SUPER_ADMIN', null);
  const other = await createTenant();
  tenantIds.push(other.id);
  outsider = await createActor('TENANT_ADMIN', other.id);
}, 60000);

beforeEach(() => {
  installFirebaseMock();
  vi.stubEnv('FRONTEND_BASE_URL', BASE);
  clearSentEmails();
  eventLimit = null;
  vi.spyOn(subscriptionTierConfigRepository, 'findByTier').mockImplementation(async (tier: SubscriptionTier) => {
    const config = await realFindByTier(tier);
    return config ? { ...config, maxEvents: eventLimit } : config;
  });
  mockDestroyAssets.mockReset();
  mockDestroyAssets.mockImplementation(async (publicIds: string[]) => ({ ok: true, deleted: publicIds, failed: [] }));
  mockDestroyAsset.mockReset();
  mockDestroyAsset.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  await cleanupTenants(tenantIds.splice(0));
  await restoreElevate();
}, 120000);

// What a sweep asked Cloudinary to delete from this event's folder, and as
// which resource type.
const destroyedIn = (ev: TestEvent, resourceType?: 'image' | 'video'): string[] =>
  mockDestroyAssets.mock.calls
    .filter((call) => !resourceType || call[1] === resourceType)
    .flatMap((call) => call[0] as string[])
    .filter((id) => id.startsWith(`${ev.folder}/`));

const archiveViaApi = async (ev: TestEvent) => {
  const res = await request(app).delete(`/api/events/${ev.event.id}`).set(headersFor(organiser));
  expect(res.status).toBe(200);
};

// Moves the retention clock: the event archived `days` days ago.
const archivedDaysAgo = (ev: TestEvent, days: number) =>
  prisma.event.update({ where: { id: ev.event.id }, data: { isArchived: true, archivedAt: new Date(Date.now() - days * DAY_MS) } });

// The reminder for the event's current archiving, as if a sweep had sent it
// `days` days ago.
const remindedDaysAgo = async (ev: TestEvent, days: number) => {
  const { archivedAt } = await prisma.event.findUniqueOrThrow({ where: { id: ev.event.id } });
  await prisma.mediaPurgeReminderClaim.create({
    data: { eventId: ev.event.id, archivedAt: archivedAt!, recipientCount: 1, claimedAt: new Date(Date.now() - days * DAY_MS) },
  });
};

// Due for its purge: archived 31 days ago and reminded 8 days ago (a purge
// waits a full week after its reminder).
const dueForPurge = async (ev: TestEvent) => {
  const event = await archivedDaysAgo(ev, 31);
  await remindedDaysAgo(ev, 8);
  return event;
};

const restoreViaApi = (ev: TestEvent) =>
  request(app).post(`/api/events/${ev.event.id}/reactivate`).set(headersFor(superAdmin));

const items = (ev: TestEvent) => prisma.memoryItem.findMany({ where: { memoryHubId: ev.hubId }, orderBy: { createdAt: 'asc' } });

const memoriesLink = (eventId: string) => `${BASE}/events/${eventId}/manage/memories`;
const remindersFor = (eventId: string) => sentEmails().filter((e) => e.text.includes(memoriesLink(eventId)));

describe('the purge: 30 days after archiving, not before', () => {
  it('archiving records archivedAt; at 29 days nothing is deleted; past 30 the media goes, the rows, event and cover stay', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const cover = `${coverFolder(tenantId)}/${randomUUID()}`;
    await prisma.event.update({ where: { id: ev.event.id }, data: { coverImagePublicId: cover, coverImageUrl: `https://res.cloudinary.com/x/image/upload/${cover}.jpg` } });
    const photo = await addPhoto(ev);
    const pending = await addPhoto(ev, { status: 'PENDING' });
    const rejected = await addPhoto(ev, { status: 'REJECTED' });
    const video = await addPhoto(ev, { mediaType: 'VIDEO' });

    const before = Date.now();
    await archiveViaApi(ev);
    const archived = await prisma.event.findUniqueOrThrow({ where: { id: ev.event.id } });
    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(archived.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    await archivedDaysAgo(ev, 29);
    await mediaRetentionService.sweep();
    expect(destroyedIn(ev)).toEqual([]);
    expect(await prisma.eventMediaPurge.count({ where: { eventId: ev.event.id } })).toBe(0);
    expect((await items(ev)).every((i) => i.purgedAt === null)).toBe(true);

    await dueForPurge(ev);
    await mediaRetentionService.sweep();

    // Every item's file, whatever its status, each as its own resource type;
    // nothing else (the cover is not in the Memory Hub folder, and was never sent).
    expect(destroyedIn(ev, 'image').sort()).toEqual([photo, pending, rejected].map((i) => i.cloudinaryPublicId).sort());
    expect(destroyedIn(ev, 'video')).toEqual([video.cloudinaryPublicId]);
    expect(mockDestroyAssets.mock.calls.flatMap((c) => c[0] as string[])).not.toContain(cover);

    const after = await items(ev);
    expect(after).toHaveLength(4);
    expect(after.every((i) => i.purgedAt !== null && i.isArchived)).toBe(true);

    const purge = await prisma.eventMediaPurge.findFirstOrThrow({ where: { eventId: ev.event.id } });
    expect(purge).toMatchObject({ reason: 'RETENTION', requestedBy: null, purgedCount: 4, failedCount: 0, lastError: null });
    expect(purge.completedAt).not.toBeNull();

    const kept = await prisma.event.findUniqueOrThrow({ where: { id: ev.event.id } });
    expect(kept).toMatchObject({ isArchived: true, coverImagePublicId: cover });
  });
});

describe('restoring', () => {
  it('before the purge cancels it', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const photo = await addPhoto(ev);
    await archiveViaApi(ev);
    await dueForPurge(ev);

    const res = await restoreViaApi(ev);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isArchived: false, archivedAt: null, mediaPurgeAt: null, mediaPurgedAt: null });

    await mediaRetentionService.sweep();
    expect(destroyedIn(ev)).toEqual([]);
    expect(await prisma.eventMediaPurge.count({ where: { eventId: ev.event.id } })).toBe(0);
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: photo.id } })).purgedAt).toBeNull();
  });

  it('after the purge brings the event back without its media, and a purged photo cannot be restored', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const photo = await addPhoto(ev);
    await archiveViaApi(ev);
    await dueForPurge(ev);
    await mediaRetentionService.sweep();

    const res = await restoreViaApi(ev);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isArchived: false, archivedAt: null, mediaPurgeAt: null });
    expect(res.body.data.mediaPurgedAt).not.toBeNull();

    const list = await request(app).get(`/api/events/${ev.event.id}/memory-hub/${ev.hubId}/items`).set(headersFor(organiser));
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    const restoreItem = await request(app)
      .post(`/api/events/${ev.event.id}/memory-hub/${ev.hubId}/items/${photo.id}/reactivate`)
      .set(headersFor(organiser));
    expect(restoreItem.status).toBe(409);
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: photo.id } })).isArchived).toBe(true);
  });

  it("respects the plan's event limit with EVENT_LIMIT_REACHED, as creating does", async () => {
    const tenant = await createTenant();
    tenantIds.push(tenant.id);
    const admin = await createActor('TENANT_ADMIN', tenant.id);
    await newEvent(tenant.id, admin.id); // live
    const ev = await newEvent(tenant.id, admin.id);
    await archivedDaysAgo(ev, 1);

    eventLimit = 1;
    const refused = await restoreViaApi(ev);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('EVENT_LIMIT_REACHED');
    expect(refused.body.message).toMatch(/Archive another of its events, then restore this one\./);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ev.event.id } })).isArchived).toBe(true);

    // With payments off, no plan named (tier-refusal-wording.util.ts).
    vi.stubEnv('FEATURES_DISABLED', 'payments');
    const launch = await restoreViaApi(ev);
    expect(launch.status).toBe(403);
    expect(launch.body.code).toBe('EVENT_LIMIT_REACHED');
    expect(launch.body.message).toMatch(/free trial/);
    expect(launch.body.message).not.toMatch(/plan/i);
    vi.stubEnv('FEATURES_DISABLED', '');

    const create = await request(app).post('/api/events').set(headersFor(admin)).send({ name: 'One too many', hostName: 'Host' });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('EVENT_LIMIT_REACHED');

    eventLimit = 2;
    expect((await restoreViaApi(ev)).status).toBe(200);
  });
});

describe('two sweeps racing', () => {
  it('purge the event once: each file deleted once, one purge, one attempt', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const photos = await Promise.all([addPhoto(ev), addPhoto(ev), addPhoto(ev)]);
    await dueForPurge(ev);

    await Promise.all([mediaRetentionService.sweep(), mediaRetentionService.sweep()]);

    expect(destroyedIn(ev).sort()).toEqual(photos.map((p) => p.cloudinaryPublicId).sort());
    const purges = await prisma.eventMediaPurge.findMany({ where: { eventId: ev.event.id } });
    expect(purges).toHaveLength(1);
    expect(purges[0]).toMatchObject({ attemptCount: 1, purgedCount: 3 });
    expect(purges[0]!.completedAt).not.toBeNull();
  });

  it('two attempts at the same purge at the same moment: the lease lets one run', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const photos = await Promise.all([addPhoto(ev), addPhoto(ev)]);
    await dueForPurge(ev);
    const now = new Date();
    const claim = await mediaRetentionRepository.claimPurge(ev.event.id, { reason: 'RETENTION', requestedBy: null, dueBy: now, now });
    expect(claim.outcome).toBe('CLAIMED');
    const purgeId = claim.outcome === 'CLAIMED' ? claim.purge.id : '';

    // Cloudinary slow enough that both attempts are past the lease check
    // before either finishes.
    mockDestroyAssets.mockImplementation(async (publicIds: string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ok: true, deleted: publicIds, failed: [] };
    });
    const outcomes = await Promise.all([mediaRetentionService.runPurge(purgeId), mediaRetentionService.runPurge(purgeId)]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(destroyedIn(ev).sort()).toEqual(photos.map((p) => p.cloudinaryPublicId).sort());
    expect(await prisma.eventMediaPurge.findUniqueOrThrow({ where: { id: purgeId } })).toMatchObject({ attemptCount: 1, purgedCount: 2 });
  });
});

describe('a failed Cloudinary deletion', () => {
  it('is recorded and retried by the next sweep, which deletes only what is left', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const [good1, bad, good2] = [await addPhoto(ev), await addPhoto(ev), await addPhoto(ev)];
    await dueForPurge(ev);

    mockDestroyAssets.mockImplementation(async (publicIds: string[]) => ({
      ok: true,
      deleted: publicIds.filter((id) => id !== bad!.cloudinaryPublicId),
      failed: publicIds.includes(bad!.cloudinaryPublicId) ? [{ publicId: bad!.cloudinaryPublicId, reason: 'rate limited' }] : [],
    }));
    await mediaRetentionService.sweep();

    let purge = await prisma.eventMediaPurge.findFirstOrThrow({ where: { eventId: ev.event.id } });
    expect(purge).toMatchObject({ completedAt: null, leaseUntil: null, purgedCount: 2, failedCount: 1, lastError: 'rate limited' });
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: bad!.id } })).purgedAt).toBeNull();
    expect((await prisma.memoryItem.findUniqueOrThrow({ where: { id: good1!.id } })).purgedAt).not.toBeNull();

    mockDestroyAssets.mockClear();
    mockDestroyAssets.mockImplementation(async (publicIds: string[]) => ({ ok: true, deleted: publicIds, failed: [] }));
    await mediaRetentionService.sweep();

    expect(destroyedIn(ev)).toEqual([bad!.cloudinaryPublicId]);
    purge = await prisma.eventMediaPurge.findFirstOrThrow({ where: { eventId: ev.event.id } });
    expect(purge).toMatchObject({ purgedCount: 3, failedCount: 0, lastError: null, attemptCount: 2 });
    expect(purge.completedAt).not.toBeNull();
    expect((await items(ev)).every((i) => i.purgedAt !== null)).toBe(true);
    expect(good2).toBeDefined();
  });

  it('a whole batch refused is retried the same way', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    await addPhoto(ev);
    await addPhoto(ev);
    await dueForPurge(ev);

    mockDestroyAssets.mockImplementation(async () => ({ ok: false, reason: 'HTTP 500' }));
    await mediaRetentionService.sweep();
    let purge = await prisma.eventMediaPurge.findFirstOrThrow({ where: { eventId: ev.event.id } });
    expect(purge).toMatchObject({ completedAt: null, purgedCount: 0, failedCount: 2, lastError: 'HTTP 500' });

    mockDestroyAssets.mockImplementation(async (publicIds: string[]) => ({ ok: true, deleted: publicIds, failed: [] }));
    await mediaRetentionService.sweep();
    purge = await prisma.eventMediaPurge.findFirstOrThrow({ where: { eventId: ev.event.id } });
    expect(purge).toMatchObject({ purgedCount: 2, failedCount: 0 });
    expect(purge.completedAt).not.toBeNull();
  });
});

describe('the reminder, 7 days before', () => {
  it("emails the event's organisers once, through the layout, with a button to the Memories tab", async () => {
    const creator = await createActor('TENANT_ADMIN', tenantId);
    const ev = await newEvent(tenantId, creator.id, { name: 'Gala <b>night</b>' });
    await addPhoto(ev);
    const archivedEvent = await archivedDaysAgo(ev, 24);

    await mediaRetentionService.sweep();
    // A day late, so the purge is a week from the reminder, not 30 days
    // from the archive; the email gives that date.
    const claim = await prisma.mediaPurgeReminderClaim.findFirstOrThrow({ where: { eventId: ev.event.id } });
    const purgeAt = mediaPurgeDueAt(archivedEvent.archivedAt!, claim.claimedAt);
    expect(purgeAt.getTime()).toBe(claim.claimedAt.getTime() + 7 * DAY_MS);
    const date = formatGuestDate(purgeAt);
    const emails = remindersFor(ev.event.id);
    expect(emails.map((e) => e.to)).toEqual([creator.email]);
    const [email] = emails;
    expect(email!.subject).toBe(`Photos from Gala bnight/b will be deleted on ${date}`);
    expect(email!.from).toMatch(/^"e-velope" </);
    expect(email!.html).toContain(EMAIL_LAYOUT_MARKER);
    expect(email!.html).toContain('Gala &lt;b&gt;night&lt;/b&gt;');
    expect(email!.html).not.toContain('<b>night</b>');
    expect(email!.html).toContain(`href="${memoriesLink(ev.event.id)}"`);
    expect(email!.text).toContain('Download your photos');

    await mediaRetentionService.sweep();
    expect(remindersFor(ev.event.id)).toHaveLength(1);
    expect(await prisma.mediaPurgeReminderClaim.count({ where: { eventId: ev.event.id } })).toBe(1);
    // A reminder is not the purge.
    expect(destroyedIn(ev)).toEqual([]);
  });

  it('two sweeps racing send it once', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    await addPhoto(ev);
    await archivedDaysAgo(ev, 24);
    await Promise.all([mediaRetentionService.sweep(), mediaRetentionService.sweep()]);
    expect(remindersFor(ev.event.id)).toHaveLength(1);
  });

  it('never for a restored event, one with nothing to download, or one not yet due', async () => {
    const restored = await newEvent(tenantId, organiser.id);
    await addPhoto(restored);
    await archivedDaysAgo(restored, 24);
    expect((await restoreViaApi(restored)).status).toBe(200);

    const nothingApproved = await newEvent(tenantId, organiser.id);
    await addPhoto(nothingApproved, { status: 'PENDING' });
    await addPhoto(nothingApproved, { isArchived: true });
    await archivedDaysAgo(nothingApproved, 24);

    const notYet = await newEvent(tenantId, organiser.id);
    await addPhoto(notYet);
    await archivedDaysAgo(notYet, 20);

    await mediaRetentionService.sweep();
    for (const ev of [restored, nothingApproved, notYet]) {
      expect(remindersFor(ev.event.id)).toEqual([]);
      expect(await prisma.mediaPurgeReminderClaim.count({ where: { eventId: ev.event.id } })).toBe(0);
    }
  });
});

describe('the super admin purge', () => {
  const purgeUrl = (ev: TestEvent) => `/api/admin/events/${ev.event.id}/media-purge`;

  it('deletes an archived event\'s media now, recorded with who and when; everyone else gets the global 404', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const photos = [await addPhoto(ev), await addPhoto(ev)];
    await archiveViaApi(ev);

    for (const actor of [organiser, eventAdmin, outsider]) {
      const refused = await request(app).post(purgeUrl(ev)).set(headersFor(actor));
      expect(refused.status).toBe(404);
      expect(refused.body).toEqual(ROUTE_NOT_FOUND_BODY);
    }
    expect(destroyedIn(ev)).toEqual([]);
    expect(await prisma.eventMediaPurge.count({ where: { eventId: ev.event.id } })).toBe(0);

    const before = Date.now();
    const res = await request(app).post(purgeUrl(ev)).set(headersFor(superAdmin));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ eventId: ev.event.id, reason: 'SUPER_ADMIN', requestedBy: superAdmin.id, purgedCount: 2, failedCount: 0 });
    expect(new Date(res.body.data.startedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(res.body.data.completedAt).not.toBeNull();
    expect(destroyedIn(ev).sort()).toEqual(photos.map((p) => p.cloudinaryPublicId).sort());
    expect((await items(ev)).every((i) => i.purgedAt !== null && i.updatedBy === superAdmin.id)).toBe(true);

    const again = await request(app).post(purgeUrl(ev)).set(headersFor(superAdmin));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('MEDIA_PURGE_ALREADY_STARTED');
  });

  it('refuses a live event with EVENT_NOT_ARCHIVED and an unknown one with 404, deleting nothing', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    await addPhoto(ev);
    const live = await request(app).post(purgeUrl(ev)).set(headersFor(superAdmin));
    expect(live.status).toBe(409);
    expect(live.body.code).toBe('EVENT_NOT_ARCHIVED');
    expect(destroyedIn(ev)).toEqual([]);

    const unknown = await request(app).post(`/api/admin/events/${randomUUID()}/media-purge`).set(headersFor(superAdmin));
    expect(unknown.status).toBe(404);
  });
});

describe('events archived before this release', () => {
  it("get the migration's time, so the first sweep purges nothing and sends no reminder", async () => {
    const ev = await newEvent(tenantId, organiser.id);
    await addPhoto(ev);
    // Archived long ago, as the code before archivedAt did it.
    await prisma.event.update({
      where: { id: ev.event.id },
      data: { isArchived: true, archivedAt: null, updatedAt: new Date(Date.now() - 400 * DAY_MS) },
    });

    const sql = readFileSync('prisma/migrations/20261026090000_archive_media_retention/migration.sql', 'utf8');
    const backfill = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('UPDATE'));
    expect(backfill).toHaveLength(1);
    const before = Date.now();
    await prisma.$executeRawUnsafe(backfill[0]!);

    const backfilled = await prisma.event.findUniqueOrThrow({ where: { id: ev.event.id } });
    expect(backfilled.archivedAt!.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(backfilled.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);

    await mediaRetentionService.sweep();
    expect(destroyedIn(ev)).toEqual([]);
    expect(await prisma.eventMediaPurge.count({ where: { eventId: ev.event.id } })).toBe(0);
    expect(remindersFor(ev.event.id)).toEqual([]);
  });
});

describe('the events list and views', () => {
  it('report archivedAt and the purge date; archived events are listed and readable, never writable', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    await addPhoto(ev);
    const live = await newEvent(tenantId, organiser.id);
    await archiveViaApi(ev);
    const { archivedAt } = await prisma.event.findUniqueOrThrow({ where: { id: ev.event.id } });
    const purgeAt = new Date(archivedAt!.getTime() + 30 * DAY_MS).toISOString();

    const archivedList = await request(app).get('/api/events?archived=true').set(headersFor(organiser));
    expect(archivedList.status).toBe(200);
    const listed = archivedList.body.data.find((e: { id: string }) => e.id === ev.event.id);
    expect(listed).toMatchObject({ isArchived: true, archivedAt: archivedAt!.toISOString(), mediaPurgeAt: purgeAt, mediaPurgedAt: null });
    expect(listed).not.toHaveProperty('mediaPurges');
    expect(archivedList.body.data.map((e: { id: string }) => e.id)).not.toContain(live.event.id);

    const liveList = await request(app).get('/api/events').set(headersFor(organiser));
    expect(liveList.body.data.map((e: { id: string }) => e.id)).not.toContain(ev.event.id);
    expect(liveList.body.data.find((e: { id: string }) => e.id === live.event.id)).toMatchObject({ archivedAt: null, mediaPurgeAt: null });

    const detail = await request(app).get(`/api/events/${ev.event.id}`).set(headersFor(organiser));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ isArchived: true, archivedAt: archivedAt!.toISOString(), mediaPurgeAt: purgeAt });

    // Read-only: the Memory Hub and its download open; a write is still a 404.
    expect((await request(app).get(`/api/events/${ev.event.id}/memory-hub`).set(headersFor(organiser))).status).toBe(200);
    const download = await request(app).post(`/api/events/${ev.event.id}/memory-hub/download`).set(headersFor(organiser));
    expect(download.status).toBe(200);
    expect(download.body.data.itemCount).toBe(1);
    expect((await request(app).put(`/api/events/${ev.event.id}`).set(headersFor(organiser)).send({ name: 'Renamed' })).status).toBe(404);

    // Another tenant sees none of it.
    expect((await request(app).get(`/api/events/${ev.event.id}`).set(headersFor(outsider))).status).toBe(404);
    const theirs = await request(app).get('/api/events?archived=true').set(headersFor(outsider));
    expect(theirs.body.data.map((e: { id: string }) => e.id)).not.toContain(ev.event.id);

    expect((await request(app).get('/api/events?archived=yes').set(headersFor(organiser))).status).toBe(400);

    // Once purged: the purge's own start, and when it finished.
    await dueForPurge(ev);
    await mediaRetentionService.sweep();
    const purge = await prisma.eventMediaPurge.findFirstOrThrow({ where: { eventId: ev.event.id } });
    const afterPurge = await request(app).get(`/api/events/${ev.event.id}`).set(headersFor(organiser));
    expect(afterPurge.body.data).toMatchObject({
      mediaPurgeAt: purge.startedAt.toISOString(),
      mediaPurgedAt: purge.completedAt!.toISOString(),
    });
  });
});

describe('an archived event is private to its guests at once', () => {
  // A published album with a share link and one approved photo, and an
  // invited guest's token.
  const albumWithGuest = async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const photo = await addPhoto(ev);
    const shareToken = randomUUID().replace(/-/g, '');
    await prisma.memoryHub.update({ where: { id: ev.hubId }, data: { isPublic: true, shareToken } });
    const { invite } = await newGuest(ev.event.id, organiser.id);
    const token = invite.token;
    return { ev, photo, shareToken, token };
  };

  it('the share link answers exactly as an inactive one', async () => {
    const { ev, photo, shareToken } = await albumWithGuest();
    const live = await request(app).get(`/api/memory-hub/${shareToken}`);
    expect(live.status).toBe(200);
    expect(live.body.data.items.map((i: { id: string }) => i.id)).toEqual([photo.id]);

    await archiveViaApi(ev);
    const archived = await request(app).get(`/api/memory-hub/${shareToken}`);
    const unknown = await request(app).get(`/api/memory-hub/${randomUUID().replace(/-/g, '')}`);
    expect(archived.status).toBe(404);
    expect(archived.body).toEqual({ status: 'error', message: INACTIVE_SHARE_LINK_MESSAGE });
    expect(archived.body).toEqual(unknown.body);
  });

  it("the guest's Memories view shows nothing, and uploads are refused in neutral words; organisers still read it", async () => {
    const { ev, token } = await albumWithGuest();
    const before = await request(app).post('/api/memory-hub/guest-view').send({ token });
    expect(before.body.data.available).toBe(true);
    expect((await request(app).post('/api/memory-hub/guest-upload-signature').send({ token, mediaType: 'IMAGE' })).status).toBe(200);

    await archiveViaApi(ev);

    const view = await request(app).post('/api/memory-hub/guest-view').send({ token });
    expect(view.status).toBe(200);
    expect(view.body.data).toEqual({ available: false });

    const signature = await request(app).post('/api/memory-hub/guest-upload-signature').send({ token, mediaType: 'IMAGE' });
    expect(signature.status).toBe(404);
    expect(signature.body).toEqual({ status: 'error', message: PHOTO_ALBUM_UNAVAILABLE_MESSAGE });

    // An upload signed before the archive, landing after: refused, saved
    // nowhere, and its file removed.
    const publicId = `${ev.folder}/${randomUUID()}`;
    const save = await request(app)
      .post('/api/memory-hub/guest-items')
      .send({ token, mediaUrl: deliveryUrl(publicId), cloudinaryPublicId: publicId, mediaType: 'IMAGE', bytes: 1024 });
    expect(save.status).toBe(404);
    expect(save.body).toEqual({ status: 'error', message: PHOTO_ALBUM_UNAVAILABLE_MESSAGE });
    expect(await prisma.memoryItem.count({ where: { cloudinaryPublicId: publicId } })).toBe(0);
    expect(mockDestroyAsset).toHaveBeenCalledWith(publicId, 'image');

    // Nothing a guest sees says why.
    for (const res of [view, signature, save]) expect(JSON.stringify(res.body)).not.toMatch(/archiv|memory hub|plan/i);

    const organiserView = await request(app).get(`/api/events/${ev.event.id}/memory-hub`).set(headersFor(organiser));
    expect(organiserView.status).toBe(200);
    expect(organiserView.body.data.memoryItems).toHaveLength(1);
  });

  it("a guest's upload to another event's folder is refused without touching that file", async () => {
    const { ev, token } = await albumWithGuest();
    const other = await newEvent(tenantId, organiser.id);
    await archiveViaApi(ev);
    const foreign = `${other.folder}/${randomUUID()}`;
    const save = await request(app)
      .post('/api/memory-hub/guest-items')
      .send({ token, mediaUrl: deliveryUrl(foreign), cloudinaryPublicId: foreign, mediaType: 'IMAGE', bytes: 1024 });
    expect(save.status).toBe(404);
    expect(mockDestroyAsset).not.toHaveBeenCalled();
  });
});

describe('the archiveMediaPurge flag', () => {
  it('off: no reminder, no purge (nor a retry), the super admin refused with a code, no countdown; archiving still records archivedAt', async () => {
    const reminded = await newEvent(tenantId, organiser.id);
    await addPhoto(reminded);
    await archivedDaysAgo(reminded, 24);
    const due = await newEvent(tenantId, organiser.id);
    await addPhoto(due);
    await archivedDaysAgo(due, 31);
    const failing = await newEvent(tenantId, organiser.id);
    await addPhoto(failing);
    await archivedDaysAgo(failing, 31);

    // A purge already begun, with a failure left to retry.
    mockDestroyAssets.mockImplementation(async () => ({ ok: false, reason: 'HTTP 500' }));
    await mediaRetentionService.purgeNowAsSuperAdmin(failing.event.id, superAdmin.id, 'SUPER_ADMIN').catch(() => undefined);
    expect((await prisma.eventMediaPurge.findFirstOrThrow({ where: { eventId: failing.event.id } })).completedAt).toBeNull();
    mockDestroyAssets.mockClear();
    mockDestroyAssets.mockImplementation(async (publicIds: string[]) => ({ ok: true, deleted: publicIds, failed: [] }));

    vi.stubEnv('FEATURES_DISABLED', 'archiveMediaPurge');

    const result = await mediaRetentionService.sweep();
    expect(result).toEqual({ reminders: [], purges: [] });
    expect(mockDestroyAssets).not.toHaveBeenCalled();
    expect(remindersFor(reminded.event.id)).toEqual([]);
    expect(await prisma.eventMediaPurge.count({ where: { eventId: due.event.id } })).toBe(0);
    expect(await prisma.mediaPurgeReminderClaim.count({ where: { eventId: reminded.event.id } })).toBe(0);

    const ev = await newEvent(tenantId, organiser.id);
    await addPhoto(ev);
    await archiveViaApi(ev);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ev.event.id } })).archivedAt).not.toBeNull();

    const refused = await request(app).post(`/api/admin/events/${ev.event.id}/media-purge`).set(headersFor(superAdmin));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('ARCHIVE_MEDIA_PURGE_OFF');
    expect(await prisma.eventMediaPurge.count({ where: { eventId: ev.event.id } })).toBe(0);
    // Everyone else still gets the global 404.
    expect((await request(app).post(`/api/admin/events/${ev.event.id}/media-purge`).set(headersFor(organiser))).body).toEqual(ROUTE_NOT_FOUND_BODY);

    const detail = await request(app).get(`/api/events/${ev.event.id}`).set(headersFor(organiser));
    expect(detail.body.data.archivedAt).not.toBeNull();
    expect(detail.body.data.mediaPurgeAt).toBeNull();
    const flags = await request(app).get('/api/config/features');
    expect(flags.body.data.archiveMediaPurge).toBe(false);

    // Back on: the same sweep does its work. The event past its 30 days is
    // reminded, not purged (see the next test); a purge begun before the
    // switch is retried.
    vi.stubEnv('FEATURES_DISABLED', '');
    await mediaRetentionService.sweep();
    expect(remindersFor(reminded.event.id)).toHaveLength(1);
    expect(remindersFor(due.event.id)).toHaveLength(1);
    expect(destroyedIn(due)).toEqual([]);
    expect(destroyedIn(failing)).toHaveLength(1);
  });

  it('off past the 30 days, then on: the reminder goes first, the purge moves to a week after it, nothing is deleted before', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const photo = await addPhoto(ev);
    await archivedDaysAgo(ev, 40);

    vi.stubEnv('FEATURES_DISABLED', 'archiveMediaPurge');
    await mediaRetentionService.sweep();
    expect(remindersFor(ev.event.id)).toEqual([]);

    vi.stubEnv('FEATURES_DISABLED', '');
    await mediaRetentionService.sweep();

    // The reminder first, giving the new date: a week from now.
    const claim = await prisma.mediaPurgeReminderClaim.findFirstOrThrow({ where: { eventId: ev.event.id } });
    const purgeAt = new Date(claim.claimedAt.getTime() + 7 * DAY_MS);
    const emails = remindersFor(ev.event.id);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain(`will be deleted on ${formatGuestDate(purgeAt)}`);
    expect(destroyedIn(ev)).toEqual([]);
    expect(await prisma.eventMediaPurge.count({ where: { eventId: ev.event.id } })).toBe(0);

    // The views report that date.
    const detail = await request(app).get(`/api/events/${ev.event.id}`).set(headersFor(organiser));
    expect(detail.body.data.mediaPurgeAt).toBe(purgeAt.toISOString());

    // Six days on: still nothing, and no second reminder.
    await prisma.mediaPurgeReminderClaim.update({ where: { id: claim.id }, data: { claimedAt: new Date(Date.now() - 6 * DAY_MS) } });
    await mediaRetentionService.sweep();
    expect(destroyedIn(ev)).toEqual([]);
    expect(remindersFor(ev.event.id)).toHaveLength(1);

    // A week on: purged.
    await prisma.mediaPurgeReminderClaim.update({ where: { id: claim.id }, data: { claimedAt: new Date(Date.now() - 7 * DAY_MS - 60_000) } });
    await mediaRetentionService.sweep();
    expect(destroyedIn(ev)).toEqual([photo.cloudinaryPublicId]);
  });

  it('an event with nothing to download needs no reminder: purged at 30 days', async () => {
    const ev = await newEvent(tenantId, organiser.id);
    const pending = await addPhoto(ev, { status: 'PENDING' });
    await archivedDaysAgo(ev, 31);
    await mediaRetentionService.sweep();
    expect(remindersFor(ev.event.id)).toEqual([]);
    expect(destroyedIn(ev)).toEqual([pending.cloudinaryPublicId]);
  });
});

describe("the guest's RSVP page for an archived event", () => {
  it('says only that the event is no longer available, and refuses RSVP changes; restoring opens it again', async () => {
    const ev = await newEvent(tenantId, organiser.id, { daysAgo: -10 }); // still ahead, so open to RSVPs
    const { guest, invite } = await newGuest(ev.event.id, organiser.id);
    const reply = { token: invite.token, attending: false };

    expect((await request(app).get(`/api/rsvp/validate/${invite.token}`)).status).toBe(200);
    expect((await request(app).post('/api/rsvp/submit').send(reply)).status).toBe(200);

    await archiveViaApi(ev);
    const before = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });

    const page = await request(app).get(`/api/rsvp/validate/${invite.token}`);
    expect(page.status).toBe(410);
    expect(page.body).toEqual({ status: 'error', message: EVENT_NO_LONGER_AVAILABLE_MESSAGE });
    // Nothing about the event: not its name, nor the guest's own name.
    expect(JSON.stringify(page.body)).not.toContain(ev.event.name);

    // A well-formed change (a new name), so only the archive refuses it.
    const submit = await request(app).post('/api/rsvp/submit').send({ ...reply, firstName: 'Changed' });
    expect(submit.status).toBe(410);
    expect(submit.body).toEqual({ status: 'error', message: EVENT_NO_LONGER_AVAILABLE_MESSAGE });
    const after = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } })).firstName).toBe(guest.firstName);

    const program = await request(app).post('/api/rsvp/program').send({ token: invite.token });
    expect(program.status).toBe(200);
    expect(program.body.data).toEqual({ available: false });

    for (const res of [page, submit]) expect(JSON.stringify(res.body)).not.toMatch(/archiv/i);

    expect((await restoreViaApi(ev)).status).toBe(200);
    expect((await request(app).get(`/api/rsvp/validate/${invite.token}`)).status).toBe(200);
  });
});
