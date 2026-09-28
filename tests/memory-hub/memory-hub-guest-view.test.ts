import { describe, it, expect, afterEach } from 'vitest';
import { memoryHubService } from '../../src/modules/memory-hub/memory-hub.service.js';
import { memoryHubRepository } from '../../src/modules/memory-hub/memory-hub.repository.js';
import { eventRepository } from '../../src/modules/event/event.repository.js';
import {
  MEMORY_ITEM_IMAGE_MAX_BYTES,
  MEMORY_ITEM_VIDEO_MAX_BYTES,
  MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN,
} from '../../src/modules/upload/upload-constants.js';
import {
  createTestTenant,
  deleteTestTenant,
  createTestUserRow,
  deleteTestUserRow,
  createTestEvent,
  deleteTestEvent,
  createTestGuestWithInvite,
  deleteTestGuest,
  prisma,
} from '../helpers/fixtures.js';

// ─────────────────────────────────────────
//  G3 PREREQUISITES — PART 4
//
//  Contract B: POST /api/memory-hub/guest-view (memoryHubService.getGuestView,
//  called from memory-hub-public.router.ts). Same "return flags, don't
//  throw" design and exact-shape assertions as Part 3's Contract A
//  tests. Additionally covers myPendingItems' guest-scoping — the one
//  place this endpoint returns something guest-specific rather than a
//  flat availability flag.
//
//  The test database carries NO SubscriptionTierConfig rows by
//  default (the seed script only ever touches dev/prod — see
//  prisma/seed.ts's safety guard) — tests that need Memory Hub
//  ENABLED insert/clean up their own config row explicitly, and the
//  "tier without Memory Hub" test does the same for clarity even
//  though an absent row already reads as disabled.
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

const upsertTierConfig = (tier: 'SPARK' | 'CELEBRATE', memoryHubEnabled: boolean) =>
  prisma.subscriptionTierConfig.upsert({
    where: { tier },
    create: {
      tier,
      maxEvents: null,
      maxGuestsPerEvent: null,
      maxSmsPerMonth: null,
      maxVendorSpaces: null,
      maxMemoryHubBytesPerEvent: null,
      emailEnabled: true,
      smsEnabled: false,
      vendorMarketplace: false,
      memoryHubEnabled,
      dragDropBuilder: false,
      guestExportEnabled: false,
    },
    update: { memoryHubEnabled },
  });

const deleteTierConfig = (tier: 'SPARK' | 'CELEBRATE') => prisma.subscriptionTierConfig.delete({ where: { tier } });

describe('POST /api/memory-hub/guest-view — memoryHubService.getGuestView (Contract B)', () => {
  it('unknown token: 404, not 500', async () => {
    await expect(memoryHubService.getGuestView('not-a-real-token')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('missing/non-string token: 400', async () => {
    await expect(memoryHubService.getGuestView(undefined)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('cancelled event: { available: false }, no reason given', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);
    await eventRepository.updateStatus(event.id, user.id, 'CANCELLED');

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await memoryHubService.getGuestView(invite.token);
    expect(result).toEqual({ available: false });
  });

  it('archived hub: { available: false }', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);
    const hub = await memoryHubRepository.findByEventId(event.id);
    await memoryHubService.archive(hub!.id, user.id, user.role, tenant.id);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await memoryHubService.getGuestView(invite.token);
    expect(result).toEqual({ available: false });
  });

  it('hub not yet open: { available: false }', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);
    const hub = await memoryHubRepository.findByEventId(event.id);
    await memoryHubService.update(hub!.id, user.id, user.role, tenant.id, { opensAt: '2099-01-01T00:00:00' });

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const result = await memoryHubService.getGuestView(invite.token);
    expect(result).toEqual({ available: false });
  });

  it('tier without Memory Hub: { available: false }', async () => {
    await upsertTierConfig('SPARK', false);
    const tenant = await createTestTenant(); // subscriptionTier: SPARK by construction
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id),
      () => deleteTierConfig('SPARK')
    );

    const result = await memoryHubService.getGuestView(invite.token);
    expect(result).toEqual({ available: false });
  });

  it(
    'available hub: exact response shape, and myPendingItems is scoped to THIS guest only',
    async () => {
      await upsertTierConfig('CELEBRATE', true);
      const tenant = await createTestTenant();
      await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: 'CELEBRATE' } });
      const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
      const event = await createTestEvent(tenant.id, user.id);
      const hub = await memoryHubRepository.findByEventId(event.id);
      await memoryHubService.update(hub!.id, user.id, user.role, tenant.id, { title: 'Our Gallery', description: 'Share your photos!' });

      const { guest: guestA, invite: inviteA } = await createTestGuestWithInvite(event.id, user.id, []);
      const { guest: guestB, invite: inviteB } = await createTestGuestWithInvite(event.id, user.id, []);

      const approvedItem = await memoryHubRepository.createItem(hub!.id, user.id, {
        mediaUrl: 'https://example.test/approved.jpg',
        cloudinaryPublicId: 'approved-pub-id',
        mediaType: 'IMAGE',
        bytes: 1000,
        caption: 'The big moment',
        status: 'APPROVED',
        uploadedByUserId: user.id,
      });
      const pendingA = await memoryHubRepository.createItem(hub!.id, 'guest-memory-upload', {
        mediaUrl: 'https://example.test/pending-a.jpg',
        cloudinaryPublicId: 'pending-a-pub-id',
        mediaType: 'IMAGE',
        bytes: 2000,
        status: 'PENDING',
        uploadedByGuestId: guestA.id,
      });
      const pendingB = await memoryHubRepository.createItem(hub!.id, 'guest-memory-upload', {
        mediaUrl: 'https://example.test/pending-b.jpg',
        cloudinaryPublicId: 'pending-b-pub-id',
        mediaType: 'IMAGE',
        bytes: 3000,
        status: 'PENDING',
        uploadedByGuestId: guestB.id,
      });
      const rejectedItem = await memoryHubRepository.createItem(hub!.id, 'guest-memory-upload', {
        mediaUrl: 'https://example.test/rejected.jpg',
        cloudinaryPublicId: 'rejected-pub-id',
        mediaType: 'IMAGE',
        bytes: 4000,
        status: 'REJECTED',
        uploadedByGuestId: guestA.id,
      });

      cleanup.push(
        () => prisma.memoryItem.deleteMany({ where: { memoryHubId: hub!.id } }),
        () => deleteTestGuest(guestB.id),
        () => deleteTestGuest(guestA.id),
        () => deleteTestEvent(event.id),
        () => deleteTestUserRow(user.id),
        () => deleteTestTenant(tenant.id),
        () => deleteTierConfig('CELEBRATE')
      );

      const result = await memoryHubService.getGuestView(inviteA.token);

      expect(result.available).toBe(true);
      if (!result.available) return;

      expect(result.title).toBe('Our Gallery');
      expect(result.description).toBe('Share your photos!');
      expect(result.requiresApproval).toBe(true);
      expect(result.limits).toEqual({
        imageMaxBytes: MEMORY_ITEM_IMAGE_MAX_BYTES,
        videoMaxBytes: MEMORY_ITEM_VIDEO_MAX_BYTES,
        uploadRequestsPer5Min: MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN,
      });

      // Approved-only, public projection (same shape as the share-token
      // gallery) — no rejected item, no pending items of either guest.
      expect(result.items).toEqual([
        {
          id: approvedItem.id,
          mediaUrl: 'https://example.test/approved.jpg',
          mediaType: 'IMAGE',
          caption: 'The big moment',
          createdAt: approvedItem.createdAt,
          uploaderDisplayName: user.username,
        },
      ]);
      expect(result.items.map((i) => i.id)).not.toContain(rejectedItem.id);

      // The core assertion for Part 4: only THIS guest's own pending
      // item — never guestB's.
      expect(result.myPendingItems).toEqual([
        {
          id: pendingA.id,
          mediaUrl: 'https://example.test/pending-a.jpg',
          mediaType: 'IMAGE',
          caption: null,
          createdAt: pendingA.createdAt,
        },
      ]);
      expect(result.myPendingItems.map((i) => i.id)).not.toContain(pendingB.id);

      // Regression guard from the guest's own side: guestB's view never
      // contains guestA's pending item either.
      const resultB = await memoryHubService.getGuestView(inviteB.token);
      expect(resultB.available).toBe(true);
      if (!resultB.available) return;
      expect(resultB.myPendingItems.map((i) => i.id)).toEqual([pendingB.id]);
    },
    30000
  );
});
