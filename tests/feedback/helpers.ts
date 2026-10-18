import { randomUUID } from 'crypto';
import { type MediaType, type MemoryItemStatus, type SubscriptionTierConfig } from '@prisma/client';
import { prisma, deleteTenantsDeep } from '../helpers/team.js';
import { createTestGuestWithInvite } from '../helpers/fixtures.js';
import { memoryHubFolder } from '../../src/modules/upload/upload-folders.js';
import { requireCloudinaryConfig } from '../../src/shared/cloudinary/cloudinary.client.js';
import { consentService } from '../../src/modules/consent/consent.service.js';

// ─────────────────────────────────────────
//  Feedback and sharing permissions — fixtures shared by tests/feedback/.
//  Real rows on the test database, hard-deleted afterwards (photos first:
//  they hold a guest's id; consent records, feedback and claims go with
//  their event by ON DELETE CASCADE).
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// The UTC calendar date `daysAgo` days before today (negative: in the future).
export const utcDateDaysAgo = (daysAgo: number): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * DAY_MS);
};

// The test tenants are ELEVATE (tests/helpers/team.ts): give it Memory Hub
// with no storage limit, and put back whatever was there.
let savedElevate: SubscriptionTierConfig | null = null;
export const enableMemoryHubOnElevate = async (): Promise<void> => {
  savedElevate = await prisma.subscriptionTierConfig.findUnique({ where: { tier: 'ELEVATE' } });
  await prisma.subscriptionTierConfig.upsert({
    where: { tier: 'ELEVATE' },
    create: { tier: 'ELEVATE', memoryHubEnabled: true, maxMemoryHubBytesPerEvent: null },
    update: { memoryHubEnabled: true, maxMemoryHubBytesPerEvent: null },
  });
};
export const restoreElevate = async (): Promise<void> => {
  if (!savedElevate) return;
  const { tier: _tier, updatedAt: _updatedAt, ...values } = savedElevate;
  await prisma.subscriptionTierConfig.update({ where: { tier: 'ELEVATE' }, data: values });
};

// A PUBLISHED event with one day `daysAgo` days ago (so COMPLETED when
// positive), its Memory Hub, and the hub's folder.
export const newEvent = async (
  tenantId: string,
  userId: string,
  opts: { daysAgo?: number; status?: 'DRAFT' | 'PUBLISHED' | 'CANCELLED'; name?: string } = {}
) => {
  const event = await prisma.event.create({
    data: {
      tenantId,
      createdByUserId: userId,
      name: opts.name ?? `Feedback Event ${randomUUID()}`,
      status: opts.status ?? 'PUBLISHED',
      createdBy: userId,
      updatedBy: userId,
    },
  });
  const hub = await prisma.memoryHub.create({ data: { eventId: event.id, isPublic: false, createdBy: userId, updatedBy: userId } });
  await prisma.eventDay.create({
    data: {
      eventId: event.id,
      label: 'Day 1',
      date: utcDateDaysAgo(opts.daysAgo ?? 3),
      location: 'Test Venue',
      address: '1 Test Road, Cape Town',
      createdBy: userId,
      updatedBy: userId,
    },
  });
  return { event, hubId: hub.id, folder: memoryHubFolder(tenantId, event.id) };
};

export type TestEvent = Awaited<ReturnType<typeof newEvent>>;

export const newGuest = async (eventId: string, userId: string) => createTestGuestWithInvite(eventId, userId, []);

export const deliveryUrl = (publicId: string, ext = 'jpg', resourceType: 'image' | 'video' = 'image'): string =>
  `https://res.cloudinary.com/${requireCloudinaryConfig().cloudName}/${resourceType}/upload/v1700000000/${publicId}.${ext}`;

let minute = 0;
export const addPhoto = (
  ev: TestEvent,
  opts: { guestId?: string | null; userId?: string; status?: MemoryItemStatus; mediaType?: MediaType; isArchived?: boolean } = {}
) => {
  minute += 1;
  const publicId = `${ev.folder}/${randomUUID()}`;
  return prisma.memoryItem.create({
    data: {
      memoryHubId: ev.hubId,
      mediaUrl: deliveryUrl(publicId),
      cloudinaryPublicId: publicId,
      mediaType: opts.mediaType ?? 'IMAGE',
      bytes: 1024 * 1024,
      status: opts.status ?? 'APPROVED',
      isArchived: opts.isArchived ?? false,
      uploadedByGuestId: opts.guestId === undefined ? null : opts.guestId,
      uploadedByUserId: opts.userId ?? null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 18, 0) + minute * 60_000),
      createdBy: 'test',
      updatedBy: 'test',
    },
  });
};

// The guest's own opt-in for one of their photos, recorded as the guest
// would (consentService, current wording).
export const setGuestSharing = (eventId: string, guestId: string, memoryItemId: string, granted: boolean) =>
  consentService.record([
    { eventId, kind: 'PHOTO_GUEST_PUBLIC_SHARING', memoryItemId, userId: null, guestId, action: granted ? 'GRANTED' : 'WITHDRAWN' },
  ]);

export const cleanupTenants = async (tenantIds: string[]): Promise<void> => {
  await prisma.memoryItem.deleteMany({ where: { memoryHub: { event: { tenantId: { in: tenantIds } } } } });
  await deleteTenantsDeep(tenantIds);
};
