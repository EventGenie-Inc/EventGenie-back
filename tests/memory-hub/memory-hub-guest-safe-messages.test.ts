import { describe, it, expect, afterEach } from 'vitest';
import { memoryHubService } from '../../src/modules/memory-hub/memory-hub.service.js';
import { memoryHubRepository } from '../../src/modules/memory-hub/memory-hub.repository.js';
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
//  G3 PREREQUISITES — PART 5 + GUEST UPLOAD LIMITS AND WORDING
//
//  Contract C: on guest-upload-signature and guest-items ONLY, tier/
//  plan/upgrade/storage-figure language is replaced with guest-safe
//  wording, and "Memory Hub" itself is replaced with "photo album".
//  Organiser routes keep their current messages — asserted here as a
//  regression guard, not just "the guest message changed".
// ─────────────────────────────────────────

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.shift();
    if (fn) await fn();
  }
});

// Tier names, billing language, and the product's internal name that
// must never reach a guest response — "Memory Hub" is organiser/support
// vocabulary; a guest only ever sees "photo album".
const FORBIDDEN_IN_GUEST_MESSAGE = /plan|upgrade|SPARK|CELEBRATE|ELEVATE|Memory Hub/i;

const upsertTierConfig = (tier: 'SPARK' | 'CELEBRATE', memoryHubEnabled: boolean, maxMemoryHubBytesPerEvent: number | null = null) =>
  prisma.subscriptionTierConfig.upsert({
    where: { tier },
    create: {
      tier,
      maxEvents: null,
      maxGuestsPerEvent: null,
      maxSmsPerMonth: null,
      maxVendorSpaces: null,
      maxMemoryHubBytesPerEvent,
      emailEnabled: true,
      smsEnabled: false,
      vendorMarketplace: false,
      memoryHubEnabled,
      dragDropBuilder: false,
      guestExportEnabled: false,
    },
    update: { memoryHubEnabled, maxMemoryHubBytesPerEvent },
  });

const deleteTierConfig = (tier: 'SPARK' | 'CELEBRATE') => prisma.subscriptionTierConfig.delete({ where: { tier } });

describe('Contract C — guest-safe messages (guest-upload-signature, guest-items)', () => {
  it('requestGuestUploadSignature — tier without Memory Hub: guest-safe message, no plan/tier/upgrade wording', async () => {
    await upsertTierConfig('SPARK', false);
    const tenant = await createTestTenant(); // SPARK by construction
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

    const err = await memoryHubService.requestGuestUploadSignature(invite.token, 'IMAGE').catch((e) => e);
    expect(err).toMatchObject({ statusCode: 403 });
    expect(err.message).toBe("This event doesn't have a photo album available.");
    expect(err.message).not.toMatch(FORBIDDEN_IN_GUEST_MESSAGE);
  });

  it(
    'requestGuestUploadSignature — over quota: guest-safe message, no MB figure or plan name',
    async () => {
      await upsertTierConfig('CELEBRATE', true, 100);
      const tenant = await createTestTenant();
      await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: 'CELEBRATE' } });
      const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
      const event = await createTestEvent(tenant.id, user.id);
      const hub = await memoryHubRepository.findByEventId(event.id);
      // Already over the 100-byte quota before this guest even asks.
      await memoryHubRepository.createItem(hub!.id, user.id, {
        mediaUrl: 'https://example.test/existing.jpg',
        cloudinaryPublicId: 'existing-pub-id',
        mediaType: 'IMAGE',
        bytes: 1000,
        status: 'APPROVED',
        uploadedByUserId: user.id,
      });
      const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);

      cleanup.push(
        () => prisma.memoryItem.deleteMany({ where: { memoryHubId: hub!.id } }),
        () => deleteTestGuest(guest.id),
        () => deleteTestEvent(event.id),
        () => deleteTestUserRow(user.id),
        () => deleteTestTenant(tenant.id),
        () => deleteTierConfig('CELEBRATE')
      );

      const err = await memoryHubService.requestGuestUploadSignature(invite.token, 'IMAGE').catch((e) => e);
      expect(err).toMatchObject({ statusCode: 403 });
      expect(err.message).toBe("This event's photo album is full, so new photos can't be added right now.");
      expect(err.message).not.toMatch(FORBIDDEN_IN_GUEST_MESSAGE);
      expect(err.message).not.toMatch(/\d+\s*MB/i);
    },
    30000
  );

  it(
    'createGuestItem — persisted upload would exceed quota: guest-safe message, no MB figure or plan name',
    async () => {
      await upsertTierConfig('CELEBRATE', true, 100);
      const tenant = await createTestTenant();
      await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionTier: 'CELEBRATE' } });
      const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
      const event = await createTestEvent(tenant.id, user.id);
      const hub = await memoryHubRepository.findByEventId(event.id);
      const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);

      cleanup.push(
        () => prisma.memoryItem.deleteMany({ where: { memoryHubId: hub!.id } }),
        () => deleteTestGuest(guest.id),
        () => deleteTestEvent(event.id),
        () => deleteTestUserRow(user.id),
        () => deleteTestTenant(tenant.id),
        () => deleteTierConfig('CELEBRATE')
      );

      // A single upload (1000 bytes) already exceeds the 100-byte quota
      // on its own — no pre-existing usage needed.
      const err = await memoryHubService
        .createGuestItem({
          token: invite.token,
          mediaUrl: 'https://example.test/new.jpg',
          cloudinaryPublicId: 'new-pub-id-that-does-not-exist',
          mediaType: 'IMAGE',
          bytes: 1000,
        })
        .catch((e) => e);

      expect(err).toMatchObject({ statusCode: 403 });
      expect(err.message).toBe("This event's photo album is full, so new photos can't be added right now.");
      expect(err.message).not.toMatch(FORBIDDEN_IN_GUEST_MESSAGE);
      expect(err.message).not.toMatch(/\d+\s*MB/i);
    },
    30000
  );

  it('requestGuestUploadSignature — archived (missing) album: guest-safe message, no "Memory Hub"', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const hub = await memoryHubRepository.findByEventId(event.id);
    await memoryHubService.archive(hub!.id, user.id, user.role, tenant.id);
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const err = await memoryHubService.requestGuestUploadSignature(invite.token, 'IMAGE').catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404 });
    expect(err.message).toBe("This event doesn't have a photo album yet.");
    expect(err.message).not.toMatch(FORBIDDEN_IN_GUEST_MESSAGE);
  });

  it('createGuestItem — archived (missing) album: guest-safe message, no "Memory Hub"', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const hub = await memoryHubRepository.findByEventId(event.id);
    await memoryHubService.archive(hub!.id, user.id, user.role, tenant.id);
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const err = await memoryHubService
      .createGuestItem({
        token: invite.token,
        mediaUrl: 'https://example.test/new.jpg',
        cloudinaryPublicId: 'archived-hub-pub-id',
        mediaType: 'IMAGE',
        bytes: 1000,
      })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404 });
    expect(err.message).toBe("This event doesn't have a photo album yet.");
    expect(err.message).not.toMatch(FORBIDDEN_IN_GUEST_MESSAGE);
  });

  it('requestGuestUploadSignature — album not yet open: guest-safe message, no "Memory Hub"', async () => {
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);
    const hub = await memoryHubRepository.findByEventId(event.id);
    await memoryHubService.update(hub!.id, user.id, user.role, tenant.id, { opensAt: '2099-01-01T00:00:00' });
    const { guest, invite } = await createTestGuestWithInvite(event.id, user.id, []);

    cleanup.push(
      () => deleteTestGuest(guest.id),
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id)
    );

    const err = await memoryHubService.requestGuestUploadSignature(invite.token, 'IMAGE').catch((e) => e);
    expect(err).toMatchObject({ statusCode: 403 });
    expect(err.message).toContain("This event's photo album opens on");
    expect(err.message).not.toMatch(FORBIDDEN_IN_GUEST_MESSAGE);
  });

  it('regression guard — organiser routes keep their plan-naming messages unchanged', async () => {
    await upsertTierConfig('SPARK', false);
    const tenant = await createTestTenant();
    const user = await createTestUserRow({ role: 'TENANT_ADMIN', tenantId: tenant.id });
    const event = await createTestEvent(tenant.id, user.id);

    cleanup.push(
      () => deleteTestEvent(event.id),
      () => deleteTestUserRow(user.id),
      () => deleteTestTenant(tenant.id),
      () => deleteTierConfig('SPARK')
    );

    // memoryHubService.getByEventId is the ORGANISER path — default
    // audience, must still name the plan and suggest an upgrade.
    const err = await memoryHubService.getByEventId(event.id, user.role, user.tenantId).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 403 });
    expect(err.message).toContain('SPARK');
    expect(err.message).toContain('Upgrade');
  });
});
