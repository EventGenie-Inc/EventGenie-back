import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type MediaType, type MemoryItemStatus, type SubscriptionTierConfig } from '@prisma/client';
import app from '../../src/app.js';
import {
  createTenant,
  createActor,
  createEventWithDay,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';
import { memoryHubFolder } from '../../src/modules/upload/upload-folders.js';
import { signCloudinaryParams } from '../../src/shared/cloudinary/cloudinary-signature.util.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
import { CLOUDINARY_ARCHIVE_MAX_FILES } from '../../src/shared/cloudinary/cloudinary-archive.util.js';
import {
  ARCHIVE_PART_MAX_BYTES,
  ARCHIVE_URL_MAX_LENGTH,
  DOWNLOAD_LINK_TTL_MS,
  archiveNameFor,
  packArchiveParts,
} from '../../src/modules/memory-hub/memory-hub-download.service.js';
import { MEMORY_HUB_DOWNLOADS_PER_EVENT_PER_HOUR } from '../../src/shared/middleware/rate-limit.middleware.js';

// ─────────────────────────────────────────
//  MEMORY HUB — DOWNLOAD ALL
//
//  POST /api/events/:eventId/memory-hub/download: signed, short-lived
//  Cloudinary archive links for the event's approved, live items, by exact
//  public id; split into parts under Cloudinary's limits; readable, safe
//  zip names; flag-guarded, tenant-scoped, under the assignment lock, and
//  rate limited per event. Cloudinary is never called: the links are
//  checked by reading them (and re-signing them).
// ─────────────────────────────────────────

let savedElevate: SubscriptionTierConfig | null = null;
const tenantIds: string[] = [];
let tenantId: string;
let organiser: Actor;

beforeAll(async () => {
  savedElevate = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'ELEVATE' },
    create: { tier: 'ELEVATE', memoryHubEnabled: true, maxMemoryHubBytesPerEvent: null },
    update: { memoryHubEnabled: true, maxMemoryHubBytesPerEvent: null },
  });
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  tenantId = tenant.id;
  organiser = await createActor('TENANT_ADMIN', tenant.id);
}, 60000);

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.memoryItem.deleteMany({ where: { memoryHub: { event: { tenantId: { in: tenantIds } } } } });
  await deleteTenantsDeep(tenantIds.splice(0));
  if (savedElevate) {
    const { tier: _tier, updatedAt: _updatedAt, ...values } = savedElevate;
    await prisma.subscriptionTierConfig.update({ where: { tier: 'ELEVATE' }, data: values });
  }
}, 120000);

const newEvent = async (name?: string, owner: { tenantId: string; userId: string } = { tenantId, userId: organiser.id }) => {
  const { event } = await createEventWithDay(owner.tenantId, owner.userId, name);
  const hub = await prisma.memoryHub.findFirstOrThrow({ where: { eventId: event.id } });
  return { event, hubId: hub.id, folder: memoryHubFolder(owner.tenantId, event.id) };
};

type Ev = Awaited<ReturnType<typeof newEvent>>;

let minute = 0;
const addItem = (ev: Ev, opts: { status?: MemoryItemStatus; mediaType?: MediaType; isArchived?: boolean; bytes?: number; folder?: string } = {}) => {
  minute += 1;
  const publicId = `${opts.folder ?? ev.folder}/${randomUUID()}`;
  return prisma.memoryItem.create({
    data: {
      memoryHubId: ev.hubId,
      mediaUrl: `https://res.cloudinary.com/test/image/upload/${publicId}.jpg`,
      cloudinaryPublicId: publicId,
      mediaType: opts.mediaType ?? 'IMAGE',
      bytes: opts.bytes ?? 2 * 1024 * 1024,
      status: opts.status ?? 'APPROVED',
      isArchived: opts.isArchived ?? false,
      createdAt: new Date(Date.UTC(2027, 2, 1, 18, 0) + minute * 60_000),
      createdBy: organiser.id,
      updatedBy: organiser.id,
    },
  });
};

const download = (eventId: string, actor: Actor = organiser) =>
  request(app).post(`/api/events/${eventId}/memory-hub/download`).set(headersFor(actor));

// Every public id an archive URL names, in order.
const idsIn = (url: string) => new URL(url).searchParams.getAll('public_ids[]');

describe('what goes in', () => {
  it('exactly the approved, live items, by public id, oldest first; never pending, rejected, archived or another folder', async () => {
    installFirebaseMock();
    const ev = await newEvent();
    const first = await addItem(ev);
    await addItem(ev, { status: 'PENDING' });
    await addItem(ev, { status: 'REJECTED' });
    await addItem(ev, { isArchived: true });
    await addItem(ev, { folder: memoryHubFolder(tenantId, 'some-other-event') });
    const second = await addItem(ev);

    const res = await download(ev.event.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ itemCount: 2, photoCount: 2, videoCount: 0 });
    expect(res.body.data.parts).toHaveLength(1);
    const [part] = res.body.data.parts;
    expect(part).toMatchObject({ part: 1, partCount: 1, mediaType: 'IMAGE', itemCount: 2, bytes: 4 * 1024 * 1024 });
    expect(idsIn(part.url)).toEqual([first.cloudinaryPublicId, second.cloudinaryPublicId]);
    // Never a folder prefix, which would sweep in the pending and rejected ones.
    expect(new URL(part.url).searchParams.has('prefixes')).toBe(false);
  }, 60000);

  it('videos only while memoryHubVideo is on, in their own part', async () => {
    installFirebaseMock();
    const ev = await newEvent();
    const photo = await addItem(ev);
    const video = await addItem(ev, { mediaType: 'VIDEO', bytes: 30 * 1024 * 1024 });

    vi.stubEnv('FEATURES_DISABLED', 'memoryHubVideo');
    const off = await download(ev.event.id);
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ itemCount: 1, photoCount: 1, videoCount: 0 });
    expect(off.body.data.parts.flatMap((p: { url: string }) => idsIn(p.url))).toEqual([photo.cloudinaryPublicId]);

    vi.stubEnv('FEATURES_DISABLED', '');
    const on = await download(ev.event.id);
    expect(on.body.data).toMatchObject({ itemCount: 2, photoCount: 1, videoCount: 1 });
    const [photos, videos] = on.body.data.parts;
    expect(photos).toMatchObject({ part: 1, partCount: 2, mediaType: 'IMAGE' });
    expect(videos).toMatchObject({ part: 2, partCount: 2, mediaType: 'VIDEO', itemCount: 1 });
    expect(new URL(videos.url).pathname).toMatch(/\/video\/generate_archive$/);
    expect(idsIn(videos.url)).toEqual([video.cloudinaryPublicId]);
  }, 60000);

  it('nothing approved is 422 MEMORY_HUB_NOTHING_TO_DOWNLOAD', async () => {
    installFirebaseMock();
    const ev = await newEvent();
    await addItem(ev, { status: 'PENDING' });
    await addItem(ev, { status: 'REJECTED' });
    const res = await download(ev.event.id);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      status: 'error',
      message: "There are no approved photos to download yet. Approve guests' photos in the Memory Hub, then try again.",
      code: 'MEMORY_HUB_NOTHING_TO_DOWNLOAD',
    });
  }, 60000);
});

describe('the links', () => {
  it('are signed download-mode archive URLs for this account, expiring in 30 minutes, every file at the zip root', async () => {
    installFirebaseMock();
    const ev = await newEvent();
    await addItem(ev);
    const before = Date.now();
    const res = await download(ev.event.id);
    const { url } = res.body.data.parts[0];
    const parsed = new URL(url);
    const { cloudName, apiKey, apiSecret } = requireCloudinaryConfig();
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`https://api.cloudinary.com/v1_1/${cloudName}/image/generate_archive`);

    const q = parsed.searchParams;
    expect(q.get('mode')).toBe('download');
    expect(q.get('flatten_folders')).toBe('true');
    expect(q.get('api_key')).toBe(apiKey);
    const expiresAt = Number(q.get('expires_at')) * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(Math.floor((before + DOWNLOAD_LINK_TTL_MS) / 1000) * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + DOWNLOAD_LINK_TTL_MS);
    expect(new Date(res.body.data.expiresAt).getTime()).toBeCloseTo(expiresAt, -4);

    // Re-signing what the URL carries gives its signature (Cloudinary's rule).
    const signed: Record<string, string> = {};
    for (const [key, value] of q) {
      if (key === 'api_key' || key === 'signature' || key === 'public_ids[]') continue;
      signed[key] = value;
    }
    signed['public_ids'] = q.getAll('public_ids[]').join(',');
    expect(q.get('signature')).toBe(signCloudinaryParams(signed, apiSecret));
  }, 60000);

  it('zip names are readable and carry no email, phone or token, whatever the event is called', async () => {
    installFirebaseMock();
    const ev = await newEvent('Acme Year-End 2026 RSVP thandi@acme.co.za or +27 82 555 0101 — Café');
    await addItem(ev);
    const res = await download(ev.event.id);
    const [part] = res.body.data.parts;
    expect(part.fileName).toBe('Acme-Year-End-2026-RSVP-or-Cafe-photos.zip');
    expect(new URL(part.url).searchParams.get('target_public_id')).toBe('Acme-Year-End-2026-RSVP-or-Cafe-photos');
    expect(JSON.stringify(res.body)).not.toMatch(/thandi|acme\.co\.za|555|0101/i);

    expect(archiveNameFor('Wedding', 'photos', 2, 3)).toBe('Wedding-photos-part-2-of-3');
    expect(archiveNameFor('@@@ 0825550101', 'videos', 1, 1)).toBe('event-videos');
  }, 60000);
});

describe('parts', () => {
  it('a 200-photo event comes as numbered parts, each URL under the length budget, every photo exactly once', async () => {
    installFirebaseMock();
    const ev = await newEvent('Two hundred');
    await prisma.memoryItem.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        memoryHubId: ev.hubId,
        mediaUrl: 'https://res.cloudinary.com/test/image/upload/x.jpg',
        cloudinaryPublicId: `${ev.folder}/${randomUUID()}`,
        mediaType: 'IMAGE' as const,
        bytes: 1024 * 1024,
        status: 'APPROVED' as const,
        createdAt: new Date(Date.UTC(2027, 2, 1) + i * 1000),
        createdBy: organiser.id,
        updatedBy: organiser.id,
      })),
    });
    const res = await download(ev.event.id);
    expect(res.status).toBe(200);
    const parts = res.body.data.parts as { part: number; partCount: number; itemCount: number; url: string; fileName: string }[];
    expect(parts.length).toBe(3);
    parts.forEach((p, i) => {
      expect(p).toMatchObject({ part: i + 1, partCount: 3 });
      expect(p.fileName).toBe(`Two-hundred-photos-part-${i + 1}-of-3.zip`);
      expect(p.url.length).toBeLessThanOrEqual(ARCHIVE_URL_MAX_LENGTH);
      expect(idsIn(p.url)).toHaveLength(p.itemCount);
    });
    const all = parts.flatMap((p) => idsIn(p.url));
    expect(all).toHaveLength(200);
    expect(new Set(all).size).toBe(200);
  }, 60000);

  it('a part never passes 1,000 files or the size budget; one oversized item goes alone', () => {
    // Even one-character ids fill the URL budget before 1,000 files (about
    // 19 characters each), so the URL is what splits them; the file cap is
    // a guard that can't be reached today.
    const shortIds = Array.from({ length: CLOUDINARY_ARCHIVE_MAX_FILES + 1 }, (_, i) => ({ cloudinaryPublicId: `${i % 10}`, bytes: 1 }));
    const byCount = packArchiveParts(shortIds);
    expect(byCount.flat()).toHaveLength(CLOUDINARY_ARCHIVE_MAX_FILES + 1);
    expect(byCount.length).toBeGreaterThan(1);
    for (const part of byCount) expect(part.length).toBeLessThan(CLOUDINARY_ARCHIVE_MAX_FILES);

    const mb = 1024 * 1024;
    const bySize = packArchiveParts([40, 40, 40, 120, 10].map((n, i) => ({ cloudinaryPublicId: `v${i}`, bytes: n * mb })));
    expect(bySize.map((p) => p.map((i) => i.cloudinaryPublicId))).toEqual([['v0', 'v1'], ['v2'], ['v3'], ['v4']]);
    for (const part of bySize.filter((p) => p.length > 1)) {
      expect(part.reduce((s, i) => s + i.bytes, 0)).toBeLessThanOrEqual(ARCHIVE_PART_MAX_BYTES);
    }
  });
});

describe('who can ask', () => {
  it('the flag off is the global 404 for a tenant, and a SUPER_ADMIN still gets links', async () => {
    installFirebaseMock();
    const ev = await newEvent();
    await addItem(ev);
    vi.stubEnv('FEATURES_DISABLED', 'memoryHubDownload');
    const res = await download(ev.event.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'error', message: 'Route not found' });

    const superAdmin = await createActor('SUPER_ADMIN', null);
    try {
      expect((await download(ev.event.id, superAdmin)).status).toBe(200);
    } finally {
      await prisma.user.delete({ where: { id: superAdmin.id } });
    }
  }, 60000);

  it("another tenant's event and a locked member's unassigned event are 404", async () => {
    installFirebaseMock();
    const ev = await newEvent();
    await addItem(ev);

    const otherTenant = await createTenant();
    tenantIds.push(otherTenant.id);
    const stranger = await createActor('TENANT_ADMIN', otherTenant.id);
    expect((await download(ev.event.id, stranger)).status).toBe(404);

    const member = await createActor('EVENT_ADMIN', tenantId);
    const assigned = await newEvent();
    await prisma.eventAssignment.create({ data: { tenantId, userId: member.id, eventId: assigned.event.id, createdBy: organiser.id } });
    expect((await download(ev.event.id, member)).status).toBe(404);
    await addItem(assigned);
    expect((await download(assigned.event.id, member)).status).toBe(200);
  }, 60000);
});

describe('rate limit, per event', () => {
  it('the sixth set of links in an hour is 429 with a code; refusals spend nothing; another event is unaffected', async () => {
    installFirebaseMock();
    const ev = await newEvent();
    const empty = await newEvent();

    // Refused requests (nothing approved) never count.
    for (let i = 0; i < MEMORY_HUB_DOWNLOADS_PER_EVENT_PER_HOUR + 2; i++) {
      expect((await download(empty.event.id)).status).toBe(422);
    }
    await addItem(empty);
    expect((await download(empty.event.id)).status).toBe(200);

    await addItem(ev);
    for (let i = 0; i < MEMORY_HUB_DOWNLOADS_PER_EVENT_PER_HOUR; i++) {
      expect((await download(ev.event.id)).status).toBe(200);
    }
    const limited = await download(ev.event.id);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      status: 'error',
      message: "You've prepared this event's download several times in the last hour. Use the links you already have, or try again in an hour.",
      code: 'MEMORY_HUB_DOWNLOAD_RATE_LIMIT',
    });
    expect((await download(empty.event.id)).status).toBe(200);
  }, 120000);
});
