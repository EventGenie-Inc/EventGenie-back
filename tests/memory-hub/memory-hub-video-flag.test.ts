import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { type SubscriptionTierConfig } from '@prisma/client';
import { memoryHubService } from '../../src/modules/memory-hub/memory-hub.service.js';
import { uploadService } from '../../src/modules/upload/upload.service.js';
import {
  MEMORY_ITEM_IMAGE_ALLOWED_FORMATS,
  MEMORY_ITEM_IMAGE_MAX_BYTES,
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
//  FREE PILOT — `memoryHubVideo` off. No Memory Hub upload signature is
//  issued for a video, guest or organiser: 422 MEMORY_HUB_VIDEO_UNAVAILABLE.
//  Photos still sign, and guest-view's limits offer photos only.
// ─────────────────────────────────────────

let savedCelebrate: SubscriptionTierConfig | null = null;
let tenantId: string;
let userId: string;
let eventId: string;
let guestId: string;
let token: string;

beforeAll(async () => {
  savedCelebrate = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'CELEBRATE' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'CELEBRATE' },
    create: { tier: 'CELEBRATE', memoryHubEnabled: true, maxMemoryHubBytesPerEvent: null },
    update: { memoryHubEnabled: true, maxMemoryHubBytesPerEvent: null },
  });
  tenantId = (await createTestTenant()).id;
  await prisma.tenant.update({ where: { id: tenantId }, data: { subscriptionTier: 'CELEBRATE' } });
  userId = (await createTestUserRow({ role: 'TENANT_ADMIN', tenantId })).id;
  eventId = (await createTestEvent(tenantId, userId)).id;
  const { guest, invite } = await createTestGuestWithInvite(eventId, userId, []);
  guestId = guest.id;
  token = invite.token;
}, 60000);

afterAll(async () => {
  await deleteTestGuest(guestId);
  await deleteTestEvent(eventId);
  await deleteTestUserRow(userId);
  await deleteTestTenant(tenantId);
  if (savedCelebrate) {
    const { tier: _tier, updatedAt: _updatedAt, ...values } = savedCelebrate;
    await prisma.subscriptionTierConfig.update({ where: { tier: 'CELEBRATE' }, data: values });
  } else {
    await prisma.subscriptionTierConfig.deleteMany({ where: { tier: 'CELEBRATE' } });
  }
}, 60000);

afterEach(() => {
  vi.unstubAllEnvs();
});

const organiserSignature = (mediaType: 'IMAGE' | 'VIDEO') =>
  uploadService.requestSignature('TENANT_ADMIN', tenantId, { purpose: 'MEMORY_ITEM', eventId, mediaType });

describe('memoryHubVideo off', () => {
  it('a guest’s video upload signature is 422 with a code and no plan wording', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'memoryHubVideo');
    await expect(memoryHubService.requestGuestUploadSignature(token, 'VIDEO')).rejects.toMatchObject({
      statusCode: 422,
      code: 'MEMORY_HUB_VIDEO_UNAVAILABLE',
      message: "Videos can't be added to this photo album right now. You can still add photos.",
    });
  }, 30000);

  it('an organiser’s video upload signature is 422 with the same code', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'memoryHubVideo');
    await expect(organiserSignature('VIDEO')).rejects.toMatchObject({ statusCode: 422, code: 'MEMORY_HUB_VIDEO_UNAVAILABLE' });
  }, 30000);

  it('photos still sign, for guests and organisers, with image formats only', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'memoryHubVideo');
    const guest = await memoryHubService.requestGuestUploadSignature(token, 'IMAGE');
    expect(guest.allowedFormats).toBe(MEMORY_ITEM_IMAGE_ALLOWED_FORMATS);
    expect(guest.uploadUrl).toMatch(/\/image\/upload$/);
    const organiser = await organiserSignature('IMAGE');
    expect(organiser.allowedFormats).toBe(MEMORY_ITEM_IMAGE_ALLOWED_FORMATS);
  }, 30000);

  it('guest-view’s limits offer photos only', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'memoryHubVideo');
    const view = await memoryHubService.getGuestView(token);
    expect(view.available).toBe(true);
    if (!view.available) return;
    expect(view.limits).toEqual({
      imageMaxBytes: MEMORY_ITEM_IMAGE_MAX_BYTES,
      videosAllowed: false,
      videoMaxBytes: null,
      allowedFormats: MEMORY_ITEM_IMAGE_ALLOWED_FORMATS,
      uploadRequestsPer5Min: MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN,
    });
  }, 30000);
});

describe('memoryHubVideo on', () => {
  it('video signatures are issued for guests and organisers, and guest-view offers video', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const guest = await memoryHubService.requestGuestUploadSignature(token, 'VIDEO');
    expect(guest.uploadUrl).toMatch(/\/video\/upload$/);
    const organiser = await organiserSignature('VIDEO');
    expect(organiser.uploadUrl).toMatch(/\/video\/upload$/);
    const view = await memoryHubService.getGuestView(token);
    if (!view.available) throw new Error('expected an available hub');
    expect(view.limits.videosAllowed).toBe(true);
    expect(view.limits.allowedFormats).toMatch(/mp4/);
  }, 30000);
});
