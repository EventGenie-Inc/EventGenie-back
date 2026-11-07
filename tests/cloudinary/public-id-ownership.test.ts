import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────
//  CLIENT-SUPPLIED CLOUDINARY publicIds — accepted only through their record
//
//  Memory Hub items (guest and organiser), event covers (create, update)
//  and the wizard's materialize path all take a publicId from the request.
//  Any guest can read another event's publicId off a Cloudinary URL. A
//  publicId is now accepted only if its StoredFile says this server signed
//  it, for this tenant, this event (or, for a cover, no event yet) and this
//  kind, and it is still unsaved; anything else is a 422 and NOTHING is
//  requested for deletion (another owner's file is never this request's to
//  delete). Too large or over quota is measured by Cloudinary (the fake,
//  tests/helpers/fake-cloudinary.ts), never taken from the request.
// ─────────────────────────────────────────

const { memoryHubService } = await import('../../src/modules/memory-hub/memory-hub.service.js');
const { memoryHubRepository } = await import('../../src/modules/memory-hub/memory-hub.repository.js');
const { eventService } = await import('../../src/modules/event/event.service.js');
const { eventDraftService } = await import('../../src/modules/event-draft/event-draft.service.js');
const { eventDraftRepository } = await import('../../src/modules/event-draft/event-draft.repository.js');
const { memoryHubFolder, tenantCoverFolder } = await import('../../src/modules/upload/upload-folders.js');
const { fakeCloudinary } = await import('../helpers/fake-cloudinary.js');
const { signedUpload, storedFile } = await import('../helpers/storage.js');
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

const OVERSIZED = 500 * 1024 * 1024; // over every limit

const { requireCloudinaryConfig } = await import('../../src/shared/cloudinary/cloudinary.client.js');
const { cloudName } = requireCloudinaryConfig();
const deliveryUrl = (resourceType: 'image' | 'video', publicId: string, ext: string): string =>
  `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/v1700000000/${publicId}.${ext}`;

const cleanup: (() => Promise<void>)[] = [];
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
const requestedDeletions = (publicIds: string[]) =>
  prisma.storedFile.count({ where: { publicId: { in: publicIds }, status: { in: ['DELETE_REQUESTED', 'DELETED'] } } });

describe("Memory Hub guest upload — publicId must be this event's own unsaved upload", () => {
  it("another event's and another tenant's real uploads, and ids never signed: 422, nothing requested for deletion, nothing stored", async () => {
    const s = await setup();
    const sibling = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantA.id, eventId: s.siblingEvent.id, mediaType: 'IMAGE', uploadedBy: { userId: s.userA.id }, bytes: OVERSIZED });
    const foreign = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantB.id, eventId: s.foreignEvent.id, mediaType: 'IMAGE', uploadedBy: { userId: s.userB.id }, bytes: OVERSIZED });
    const foreignCover = await signedUpload({ kind: 'COVER', tenantId: s.tenantB.id, eventId: null, uploadedBy: { userId: s.userB.id }, bytes: OVERSIZED });
    const attempts = [
      sibling.publicId,                                                       // same tenant, other event
      foreign.publicId,                                                       // other tenant
      foreignCover.publicId,                                                  // other tenant's cover
      `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/../../cover/${randomUUID()}`, // traversal
      `${memoryHubFolder(s.tenantA.id, s.ownEvent.id)}/${randomUUID()}`,      // the right folder, never signed
      'sample',                                                               // bare id
    ];

    for (const cloudinaryPublicId of attempts) {
      const err = await memoryHubService
        .createGuestItem({ token: s.invite.token, mediaUrl: deliveryUrl('image', cloudinaryPublicId, 'jpg'), cloudinaryPublicId, mediaType: 'IMAGE', bytes: 10 })
        .catch((e) => e);
      expect(err, cloudinaryPublicId).toMatchObject({ statusCode: 422 });
      expect(err.message).not.toMatch(/Memory Hub|plan|upgrade/i);
    }

    expect(await requestedDeletions([sibling.publicId, foreign.publicId, foreignCover.publicId])).toBe(0);
    expect(fakeCloudinary.callsTo('destroy')).toHaveLength(0);
    expect(await countItems(s.ownEvent.id)).toBe(0);
  }, 60000);

  it("control: this event's own upload reaches the size check by its REAL size and is requested for deletion", async () => {
    const s = await setup();
    const own = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantA.id, eventId: s.ownEvent.id, mediaType: 'IMAGE', uploadedBy: { inviteId: s.invite.id }, bytes: OVERSIZED });
    const err = await memoryHubService
      // The browser says 1 KB; Cloudinary holds 500 MB.
      .createGuestItem({ token: s.invite.token, mediaUrl: own.url, cloudinaryPublicId: own.publicId, mediaType: 'IMAGE', bytes: 1024 })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect(await storedFile(own.publicId)).toMatchObject({ status: 'DELETE_REQUESTED', bytes: OVERSIZED });
    expect(await countItems(s.ownEvent.id)).toBe(0);
  }, 60000);
});

describe('Memory Hub — mediaUrl must be our delivery URL for exactly the checked publicId', () => {
  it('off-Cloudinary, another account, another publicId, wrong resource type or format: 422, nothing requested or stored', async () => {
    const s = await setup();
    const own = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantA.id, eventId: s.ownEvent.id, mediaType: 'IMAGE', uploadedBy: { inviteId: s.invite.id }, bytes: OVERSIZED });
    const otherOwn = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantA.id, eventId: s.ownEvent.id, mediaType: 'IMAGE', uploadedBy: { inviteId: s.invite.id } });
    const good = own.url;
    const bad = [
      'https://evil.example.com/x.jpg',                                     // off Cloudinary
      good.replace(`/${cloudName}/`, '/someone-else/'),                     // another Cloudinary account
      good.replace('https://', 'http://'),                                  // not https
      otherOwn.url,                                                         // a different (also vetted) publicId
      deliveryUrl('video', own.publicId, 'mp4'),                            // video URL for an IMAGE item
      deliveryUrl('image', own.publicId, 'svg'),                            // a format never signed
      good.replace('/upload/', '/upload/c_fill,w_10/'),                     // transformation segment
      `${good}?x=1`,                                                        // trailing junk
    ];

    for (const mediaUrl of bad) {
      // Oversized, so an accepted pair would be requested for deletion.
      const err = await memoryHubService
        .createGuestItem({ token: s.invite.token, mediaUrl, cloudinaryPublicId: own.publicId, mediaType: 'IMAGE' })
        .catch((e) => e);
      expect(err, mediaUrl).toMatchObject({ statusCode: 422 });
      expect(err.message).not.toMatch(/Memory Hub|plan|upgrade/i);
    }

    const hub = await memoryHubRepository.findByEventId(s.ownEvent.id);
    const organiserErr = await memoryHubService
      .createOrganiserItem(s.ownEvent.id, hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
        mediaUrl: 'https://evil.example.com/x.jpg', cloudinaryPublicId: own.publicId, mediaType: 'IMAGE',
      })
      .catch((e) => e);
    expect(organiserErr).toMatchObject({ statusCode: 422 });

    expect(await requestedDeletions([own.publicId])).toBe(0);
    expect(await countItems(s.ownEvent.id)).toBe(0);
  }, 60000);

  it('control: the matching delivery URL is accepted and stored, for an image and a video, with their real sizes', async () => {
    const s = await setup();
    const hub = await memoryHubRepository.findByEventId(s.ownEvent.id);
    const image = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantA.id, eventId: s.ownEvent.id, mediaType: 'IMAGE', uploadedBy: { userId: s.userA.id }, bytes: 4321 });
    const video = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantA.id, eventId: s.ownEvent.id, mediaType: 'VIDEO', uploadedBy: { userId: s.userA.id }, bytes: 8765 });

    const savedImage = await memoryHubService.createOrganiserItem(s.ownEvent.id, hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
      mediaUrl: image.url, cloudinaryPublicId: image.publicId, mediaType: 'IMAGE', bytes: 1,
    });
    const savedVideo = await memoryHubService.createOrganiserItem(s.ownEvent.id, hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
      mediaUrl: video.url, cloudinaryPublicId: video.publicId, mediaType: 'VIDEO',
    });
    expect(savedImage).toMatchObject({ mediaUrl: image.url, bytes: 4321, storedFileId: image.fileId });
    expect(savedVideo).toMatchObject({ mediaUrl: video.url, bytes: 8765, storedFileId: video.fileId });
    expect((await storedFile(image.publicId)).status).toBe('ATTACHED');
    expect(await countItems(s.ownEvent.id)).toBe(2);

    // The same upload saved again: refused, it is already used.
    const again = await memoryHubService
      .createOrganiserItem(s.ownEvent.id, hub!.id, s.userA.id, s.userA.role, s.tenantA.id, { mediaUrl: image.url, cloudinaryPublicId: image.publicId, mediaType: 'IMAGE' })
      .catch((e) => e);
    expect(again).toMatchObject({ statusCode: 422 });
    expect(await countItems(s.ownEvent.id)).toBe(2);
  }, 60000);
});

describe('Memory Hub organiser upload — same check', () => {
  it("another tenant's upload: 422, nothing requested for deletion", async () => {
    const s = await setup();
    const hub = await memoryHubRepository.findByEventId(s.ownEvent.id);
    const foreign = await signedUpload({ kind: 'MEMORY_ITEM', tenantId: s.tenantB.id, eventId: s.foreignEvent.id, mediaType: 'IMAGE', uploadedBy: { userId: s.userB.id }, bytes: OVERSIZED });
    const err = await memoryHubService
      .createOrganiserItem(s.ownEvent.id, hub!.id, s.userA.id, s.userA.role, s.tenantA.id, {
        mediaUrl: deliveryUrl('image', foreign.publicId, 'jpg'),
        cloudinaryPublicId: foreign.publicId,
        mediaType: 'IMAGE',
      })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(await requestedDeletions([foreign.publicId])).toBe(0);
    expect(await countItems(s.ownEvent.id)).toBe(0);
  }, 60000);
});

describe("Event cover — publicId must be this tenant's own unsaved cover upload", () => {
  it("create with another tenant's cover: 422, nothing requested, no event created", async () => {
    const s = await setup();
    const foreign = await signedUpload({ kind: 'COVER', tenantId: s.tenantB.id, eventId: null, uploadedBy: { userId: s.userB.id }, bytes: OVERSIZED });
    const before = await prisma.event.count({ where: { tenantId: s.tenantA.id } });
    const err = await eventService
      .create(s.tenantA.id, s.userA.id, {
        name: 'Cover attack',
        hostName: 'Test Host',
        coverImageUrl: 'https://example.test/c.jpg',
        coverImagePublicId: foreign.publicId,
        coverImageBytes: 1,
      })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(await requestedDeletions([foreign.publicId])).toBe(0);
    expect(await prisma.event.count({ where: { tenantId: s.tenantA.id } })).toBe(before);
  }, 60000);

  it("update with another tenant's cover, or another event's: 422, nothing requested, stored cover unchanged", async () => {
    const s = await setup();
    const ownCover = `${tenantCoverFolder(s.tenantA.id)}/${randomUUID()}`;
    await prisma.event.update({ where: { id: s.ownEvent.id }, data: { coverImagePublicId: ownCover } });
    const foreign = await signedUpload({ kind: 'COVER', tenantId: s.tenantB.id, eventId: null, uploadedBy: { userId: s.userB.id }, bytes: OVERSIZED });
    const sibling = await signedUpload({ kind: 'COVER', tenantId: s.tenantA.id, eventId: s.siblingEvent.id, uploadedBy: { userId: s.userA.id }, bytes: OVERSIZED });

    for (const publicId of [foreign.publicId, sibling.publicId, `${tenantCoverFolder(s.tenantA.id)}/${randomUUID()}`]) {
      const err = await eventService
        .update(s.ownEvent.id, s.userA.id, s.userA.role, s.tenantA.id, { coverImagePublicId: publicId, coverImageBytes: 1 })
        .catch((e) => e);
      expect(err, publicId).toMatchObject({ statusCode: 422 });
    }
    expect(await requestedDeletions([foreign.publicId, sibling.publicId])).toBe(0);
    const after = await prisma.event.findUniqueOrThrow({ where: { id: s.ownEvent.id } });
    expect(after.coverImagePublicId).toBe(ownCover);
  }, 60000);

  it('update re-sending the id already stored (even a legacy one) is not re-checked', async () => {
    const s = await setup();
    await prisma.event.update({ where: { id: s.ownEvent.id }, data: { coverImagePublicId: 'legacy-cover-id' } });
    const updated = await eventService.update(s.ownEvent.id, s.userA.id, s.userA.role, s.tenantA.id, {
      name: 'Renamed', hostName: 'Test Host', coverImagePublicId: 'legacy-cover-id',
    });
    expect(updated.name).toBe('Renamed');
    expect(fakeCloudinary.callsTo('explicit')).toHaveLength(0);
  }, 60000);

  it("wizard materialize with another tenant's cover: 422, nothing requested", async () => {
    const s = await setup();
    const foreign = await signedUpload({ kind: 'COVER', tenantId: s.tenantB.id, eventId: null, uploadedBy: { userId: s.userB.id }, bytes: OVERSIZED });
    await eventDraftRepository.upsert(s.tenantA.id, s.userA.id, {
      currentStep: 4,
      payload: {
        name: 'Draft attack',
        hostName: 'Test Host',
        // A complete day (venue included), so the 422 below can only come
        // from the cover check, not a missing required field.
        days: [{ label: 'Day 1', date: '2030-01-01T00:00:00', location: 'Somewhere', address: '1 Test Road' }],
        coverImageUrl: 'https://example.test/c.jpg',
        coverImagePublicId: foreign.publicId,
        coverImageBytes: 1,
      },
    });
    const err = await eventDraftService.materialize(s.tenantA.id, s.userA.id).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 422 });
    expect(err.message).not.toMatch(/venue/);
    expect(await requestedDeletions([foreign.publicId])).toBe(0);
  }, 60000);
});
