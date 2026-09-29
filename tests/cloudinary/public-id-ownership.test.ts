import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────
//  CLIENT-SUPPLIED CLOUDINARY publicIds — ownership before destroy/store
//
//  Memory Hub items (guest and organiser), event covers (create, update)
//  and the wizard's materialize path all took a publicId from the request
//  and, on an oversized/over-quota upload, DESTROYED it with our API
//  secret, with no check that it was ever uploaded for that event. A guest
//  could read another event's publicId off any Cloudinary URL and have the
//  server delete it. Each path must now 422 a publicId outside the folder
//  this server signed for that exact event/tenant, and destroy NOTHING.
//
//  destroyAsset is mocked (the one Cloudinary boundary these paths use),
//  both to observe calls and so this suite never deletes anything real.
// ─────────────────────────────────────────

const { mockDestroyAsset } = vi.hoisted(() => ({ mockDestroyAsset: vi.fn() }));
vi.mock('../../src/shared/cloudinary/cloudinary.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/cloudinary/cloudinary.client.js')>()),
  destroyAsset: mockDestroyAsset,
}));

const { memoryHubService } = await import('../../src/modules/memory-hub/memory-hub.service.js');
const { memoryHubRepository } = await import('../../src/modules/memory-hub/memory-hub.repository.js');
const { eventService } = await import('../../src/modules/event/event.service.js');
const { eventDraftService } = await import('../../src/modules/event-draft/event-draft.service.js');
const { eventDraftRepository } = await import('../../src/modules/event-draft/event-draft.repository.js');
const { coverFolder, memoryHubFolder } = await import('../../src/modules/upload/upload-folders.js');
const {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} = await import('../helpers/fixtures.js');

const OVERSIZED = 500 * 1024 * 1024; // over every image limit, so the destroy branch is reached

const { requireCloudinaryConfig } = await import('../../src/shared/cloudinary/cloudinary.client.js');
const { cloudName } = requireCloudinaryConfig();
// Cloudinary's secure_url shape for an asset in our account.
const deliveryUrl = (resourceType: 'image' | 'video', publicId: string, ext: string): string =>
  `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/v1700000000/${publicId}.${ext}`;

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  mockDestroyAsset.mockReset();
  mockDestroyAsset.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

// Two tenants; tenant A has two events (victim + attacker's own), tenant B one.
const setup = async () => {
  const tenantA = await createTestTenant();
  const tenantB = await createTestTenant();
  const userA = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenantA.id });
  const userB = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenantB.id });
  const ownEvent = await createTestEvent(tenantA.id, userA.id);
  const siblingEvent = await createTestEvent(tenantA.id, userA.id);
  const foreignEvent = await createTestEvent(tenantB.id, userB.id);
  const { guest, invite } = await createTestGuestWithInvite(ownEvent.id, userA.id, []);
  cleanup.push(
    async () => { await prisma.memoryItem.deleteMany({ where: { memoryHub: { eventId: { in: [ownEvent.id, siblingEvent.id, foreignEvent.id] } } } }); },
    () => deleteTestGuest(guest.id),
    () => deleteTestEvent(ownEvent.id),
    () => deleteTestEvent(siblingEvent.id),
    () => deleteTestEvent(foreignEvent.id),
    async () => { await prisma.eventDraft.deleteMany({ where: { createdByUserId: { in: [userA.id, userB.id] } } }); },
    () => deleteTestUserRow(userA.id),
    () => deleteTestUserRow(userB.id),
    () => deleteTestTenant(tenantA.id),
    () => deleteTestTenant(tenantB.id)
  );
  return { tenantA, tenantB, userA, userB, ownEvent, siblingEvent, foreignEvent, invite };
};

const countItems = (eventId: string) => prisma.memoryItem.count({ where: { memoryHub: { eventId } } });

describe('Memory Hub guest upload — publicId must be in this event\'s signed folder', () => {
  it("another event's and another tenant's publicId: 422, nothing destroyed, nothing stored", async () => {
    const s = await setup();
    const attempts = [
      `${memoryHubFolder(s.tenantA.id, s.siblingEvent.id)}/${randomUUID()}`, // same tenant, other event
      `${memoryHubFolder(s.tenantB.id, s.foreignEvent.id)}/${randomUUID()}`, // other tenant
      `${coverFolder(s.tenantB.id)}/${randomUUID()}`,                        // other tenant's cover
      `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/../../covers/${randomUUID()}`, // traversal
      `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}`,                     // folder, no id
      'sample',                                                                // bare id
    ];

    for (const cloudinaryPublicId of attempts) {
      const err = await memoryHubService
        .createGuestItem({ token: s.invite.token, mediaUrl: 'https://example.test/x.jpg', cloudinaryPublicId, mediaType: 'IMAGE', bytes: OVERSIZED })
        .catch((e) => e);
      expect(err, cloudinaryPublicId).toMatchObject({ statusCode: 422 });
      expect(err.message).not.toMatch(/Memory Hub|plan|upgrade/i);
    }

    expect(mockDestroyAsset).not.toHaveBeenCalled();
    expect(await countItems(s.ownEvent.id)).toBe(0);
  }, 60000);

  it('control: an id in its own folder still reaches the size check and IS cleaned up', async () => {
    const s = await setup();
    const own = `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/${randomUUID()}`;
    const err = await memoryHubService
      .createGuestItem({ token: s.invite.token, mediaUrl: deliveryUrl('image', own, 'jpg'), cloudinaryPublicId: own, mediaType: 'IMAGE', bytes: OVERSIZED })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect(mockDestroyAsset).toHaveBeenCalledWith(own, 'image');
  }, 60000);
});

describe('Memory Hub — mediaUrl must be our delivery URL for exactly the checked publicId', () => {
  it('off-Cloudinary, another account, another publicId, wrong resource type or format: 422, nothing destroyed or stored', async () => {
    const s = await setup();
    const own = `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/${randomUUID()}`;
    const otherOwn = `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/${randomUUID()}`;
    const good = deliveryUrl('image', own, 'jpg');
    const bad = [
      'https://evil.example.com/x.jpg',                                     // off Cloudinary
      good.replace(`/${cloudName}/`, '/someone-else/'),                     // another Cloudinary account
      good.replace('https://', 'http://'),                                  // not https
      deliveryUrl('image', otherOwn, 'jpg'),                                // a different (also vetted) publicId
      deliveryUrl('video', own, 'mp4'),                                     // video URL for an IMAGE item
      deliveryUrl('image', own, 'svg'),                                     // a format never signed
      good.replace('/upload/', '/upload/c_fill,w_10/'),                     // transformation segment
      `${good}?x=1`,                                                        // trailing junk
    ];

    for (const mediaUrl of bad) {
      // Oversized, so an accepted pair would reach the destroy branch.
      const err = await memoryHubService
        .createGuestItem({ token: s.invite.token, mediaUrl, cloudinaryPublicId: own, mediaType: 'IMAGE', bytes: OVERSIZED })
        .catch((e) => e);
      expect(err, mediaUrl).toMatchObject({ statusCode: 422 });
      expect(err.message).not.toMatch(/Memory Hub|plan|upgrade/i);
    }

    const hub = await memoryHubRepository.findByEventId(s.ownEvent.id);
    const organiserErr = await memoryHubService
      .createOrganiserItem(hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
        mediaUrl: 'https://evil.example.com/x.jpg', cloudinaryPublicId: own, mediaType: 'IMAGE', bytes: 1000,
      })
      .catch((e) => e);
    expect(organiserErr).toMatchObject({ statusCode: 422 });

    expect(mockDestroyAsset).not.toHaveBeenCalled();
    expect(await countItems(s.ownEvent.id)).toBe(0);
  }, 60000);

  it('control: the matching delivery URL is accepted and stored, for an image and a video', async () => {
    const s = await setup();
    const hub = await memoryHubRepository.findByEventId(s.ownEvent.id);
    const image = `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/${randomUUID()}`;
    const video = `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/${randomUUID()}`;

    const savedImage = await memoryHubService.createOrganiserItem(hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
      mediaUrl: deliveryUrl('image', image, 'jpg'), cloudinaryPublicId: image, mediaType: 'IMAGE', bytes: 1000,
    });
    const savedVideo = await memoryHubService.createOrganiserItem(hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
      mediaUrl: deliveryUrl('video', video, 'mp4'), cloudinaryPublicId: video, mediaType: 'VIDEO', bytes: 1000,
    });
    expect(savedImage.mediaUrl).toBe(deliveryUrl('image', image, 'jpg'));
    expect(savedVideo.mediaUrl).toBe(deliveryUrl('video', video, 'mp4'));
    expect(await countItems(s.ownEvent.id)).toBe(2);
  }, 60000);
});

describe('Memory Hub organiser upload — same check', () => {
  it("another tenant's publicId: 422, nothing destroyed", async () => {
    const s = await setup();
    const hub = await memoryHubRepository.findByEventId(s.ownEvent.id);
    const err = await memoryHubService
      .createOrganiserItem(hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
        mediaUrl: 'https://example.test/x.jpg',
        cloudinaryPublicId: `${memoryHubFolder(s.tenantB.id, s.foreignEvent.id)}/${randomUUID()}`,
        mediaType: 'IMAGE',
        bytes: OVERSIZED,
      })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(mockDestroyAsset).not.toHaveBeenCalled();
    expect(await countItems(s.ownEvent.id)).toBe(0);
  }, 60000);
});

describe('Event cover — publicId must be in the tenant\'s signed cover folder', () => {
  it("create with another tenant's cover id: 422, nothing destroyed, no event created", async () => {
    const s = await setup();
    const before = await prisma.event.count({ where: { tenantId: s.tenantA.id } });
    const err = await eventService
      .create(s.tenantA.id, s.userA.id, {
        name: 'Cover attack', location: 'Somewhere',
        coverImageUrl: 'https://example.test/c.jpg',
        coverImagePublicId: `${coverFolder(s.tenantB.id)}/${randomUUID()}`,
        coverImageBytes: OVERSIZED,
      })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(mockDestroyAsset).not.toHaveBeenCalled();
    expect(await prisma.event.count({ where: { tenantId: s.tenantA.id } })).toBe(before);
  }, 60000);

  it("update with another tenant's cover id: 422, nothing destroyed, stored cover unchanged", async () => {
    const s = await setup();
    const ownCover = `${coverFolder(s.tenantA.id)}/${randomUUID()}`;
    await prisma.event.update({ where: { id: s.ownEvent.id }, data: { coverImagePublicId: ownCover } });

    for (const bytes of [OVERSIZED, 1000]) {
      const err = await eventService
        .update(s.ownEvent.id, s.userA.id, s.userA.role, s.tenantA.id, {
          coverImagePublicId: `${coverFolder(s.tenantB.id)}/${randomUUID()}`,
          coverImageBytes: bytes,
        })
        .catch((e) => e);
      expect(err).toMatchObject({ statusCode: 422 });
    }
    expect(mockDestroyAsset).not.toHaveBeenCalled();
    const after = await prisma.event.findUniqueOrThrow({ where: { id: s.ownEvent.id } });
    expect(after.coverImagePublicId).toBe(ownCover);
  }, 60000);

  it('update re-sending the id already stored (even a legacy one) is not re-checked', async () => {
    const s = await setup();
    await prisma.event.update({ where: { id: s.ownEvent.id }, data: { coverImagePublicId: 'legacy-cover-id' } });
    const updated = await eventService.update(s.ownEvent.id, s.userA.id, s.userA.role, s.tenantA.id, {
      name: 'Renamed', coverImagePublicId: 'legacy-cover-id',
    });
    expect(updated.name).toBe('Renamed');
    expect(mockDestroyAsset).not.toHaveBeenCalled();
  }, 60000);

  it("wizard materialize with another tenant's cover id: 422, nothing destroyed", async () => {
    const s = await setup();
    await eventDraftRepository.upsert(s.tenantA.id, s.userA.id, {
      currentStep: 4,
      payload: {
        name: 'Draft attack', location: 'Somewhere',
        days: [{ label: 'Day 1', date: '2030-01-01T00:00:00' }],
        coverImageUrl: 'https://example.test/c.jpg',
        coverImagePublicId: `${coverFolder(s.tenantB.id)}/${randomUUID()}`,
        coverImageBytes: OVERSIZED,
      },
    });
    const err = await eventDraftService.materialize(s.tenantA.id, s.userA.id).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(mockDestroyAsset).not.toHaveBeenCalled();
  }, 60000);
});
