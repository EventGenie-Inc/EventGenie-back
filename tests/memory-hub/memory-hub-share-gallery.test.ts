import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type MediaType } from '@prisma/client';
import app from '../../src/app.js';
import { createTenant, createActor, createEventWithDay, deleteTenantsDeep, prisma, type Actor } from '../helpers/team.js';
import { createTestGuestWithInvite } from '../helpers/fixtures.js';
import { subscriptionTierConfigRepository } from '../../src/modules/subscription-tier-config/subscription-tier-config.repository.js';
import { memoryHubRepository } from '../../src/modules/memory-hub/memory-hub.repository.js';

// ─────────────────────────────────────────
//  MEMORY HUB — PUBLIC SHARE-LINK GALLERY
//
//  GET /api/memory-hub/:shareToken. Anyone holding the link can call it,
//  so: only what the page shows (no uploader name of any kind, no host
//  name), videos only while memoryHubVideo is on, and a plan without Memory Hub answers exactly like an unknown
//  token ("This link isn't active.", no plan language). The tier rows are
//  never touched: findByTier is stubbed, so the shared rows stay as found.
// ─────────────────────────────────────────

const tenantIds: string[] = [];
let organiser: Actor;
let hubId: string;
let shareToken: string;
let guestFirstName: string;
let hostName: string;
let photoIds: string[];
let videoId: string;

type TierConfig = NonNullable<Awaited<ReturnType<typeof subscriptionTierConfigRepository.findByTier>>>;
const stubMemoryHubEnabled = (memoryHubEnabled: boolean) =>
  vi.spyOn(subscriptionTierConfigRepository, 'findByTier').mockResolvedValue({ memoryHubEnabled } as TierConfig);

beforeAll(async () => {
  const tenant = await createTenant();
  tenantIds.push(tenant.id);
  organiser = await createActor('TENANT_ADMIN', tenant.id);
  const { event } = await createEventWithDay(tenant.id, organiser.id);
  hostName = `Hosted by Lerato${randomUUID().slice(0, 8)}`;
  await prisma.event.update({ where: { id: event.id }, data: { hostName } });
  hubId = (await prisma.memoryHub.findFirstOrThrow({ where: { eventId: event.id } })).id;
  shareToken = (await memoryHubRepository.generateShareToken(hubId, organiser.id)).shareToken!;

  const { guest } = await createTestGuestWithInvite(event.id, organiser.id, []);
  guestFirstName = `Thandiwe${randomUUID().slice(0, 8)}`;
  await prisma.guest.update({ where: { id: guest.id }, data: { firstName: guestFirstName } });

  const item = (mediaType: MediaType, uploader: { uploadedByGuestId: string } | { uploadedByUserId: string }) =>
    prisma.memoryItem.create({
      data: {
        memoryHubId: hubId,
        mediaUrl: `https://res.cloudinary.com/test/${mediaType === 'VIDEO' ? 'video' : 'image'}/upload/${randomUUID()}`,
        cloudinaryPublicId: `test/${randomUUID()}`,
        mediaType,
        bytes: 1024,
        status: 'APPROVED',
        createdBy: organiser.id,
        updatedBy: organiser.id,
        ...uploader,
      },
    });
  const guestPhoto = await item('IMAGE', { uploadedByGuestId: guest.id });
  const organiserPhoto = await item('IMAGE', { uploadedByUserId: organiser.id });
  const video = await item('VIDEO', { uploadedByGuestId: guest.id });
  photoIds = [guestPhoto.id, organiserPhoto.id];
  videoId = video.id;
}, 60000);

beforeEach(() => {
  stubMemoryHubEnabled(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.memoryItem.deleteMany({ where: { memoryHubId: hubId } });
  await deleteTenantsDeep(tenantIds.splice(0));
}, 60000);

const view = (token: string) => request(app).get(`/api/memory-hub/${token}`);

describe('GET /api/memory-hub/:shareToken', () => {
  it('carries no uploader name, guest or organiser, anywhere in the response', async () => {
    const res = await view(shareToken);
    expect(res.status).toBe(200);
    const items = res.body.data.items as Record<string, unknown>[];
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['caption', 'id', 'mediaType', 'mediaUrl']);
    }
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('uploaderDisplayName');
    expect(body).not.toContain(guestFirstName);
    expect(body).not.toContain(organiser.username);
  }, 30000);

  it('carries only what the gallery page shows: no hub title or description, no host name', async () => {
    await prisma.memoryHub.update({ where: { id: hubId }, data: { title: 'Album title', description: 'Album description' } });
    const res = await view(shareToken);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['eventName', 'isCancelled', 'isOpen', 'items']);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(hostName);
    expect(body).not.toContain('Album title');
    expect(body).not.toContain('Album description');
  }, 30000);

  it('leaves videos out while memoryHubVideo is off, and returns them while it is on', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'memoryHubVideo');
    const off = await view(shareToken);
    expect(off.status).toBe(200);
    expect(off.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual([...photoIds].sort());
    expect(off.body.data.items.every((i: { mediaType: string }) => i.mediaType === 'IMAGE')).toBe(true);

    vi.stubEnv('FEATURES_DISABLED', '');
    const on = await view(shareToken);
    expect(on.status).toBe(200);
    expect(on.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual([...photoIds, videoId].sort());
  }, 30000);

  it('an unknown token is 404 "This link isn\'t active."', async () => {
    const res = await view(randomUUID().replace(/-/g, ''));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'error', message: "This link isn't active." });
  }, 30000);

  it("a plan without Memory Hub answers exactly as an unknown token", async () => {
    stubMemoryHubEnabled(false);
    const lapsed = await view(shareToken);
    const unknown = await view(randomUUID().replace(/-/g, ''));
    expect(lapsed.status).toBe(404);
    expect(lapsed.body).toEqual(unknown.body);
    expect(lapsed.body).toEqual({ status: 'error', message: "This link isn't active." });
  }, 30000);
});
