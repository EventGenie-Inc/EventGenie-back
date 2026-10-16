import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import { type MemoryItemStatus, type Prisma } from '@prisma/client';
import { type CreateMemoryHubDto, type UpdateMemoryHubDto } from './memory-hub.types.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';

// MemoryHub/MemoryItem have no tenantId of their own — ownership is
// transitive through eventId -> Event.tenantId (MemoryHub) and two hops
// further for MemoryItem. Unlike an earlier, unscoped version of this
// file, these repository methods deliberately do NOT try to filter by
// tenant themselves — that was the shape of the audit's worst finding
// (make-public had no ownership check at all). Tenant scoping instead
// happens in memory-hub.service.ts by gating every method through
// eventService.getById() first, exactly like event-day/guest/invite
// gate through it. See the batch report.
type Tx = Prisma.TransactionClient;

export const memoryHubRepository = {

  // A guest upload and its public-sharing consent are written together
  // (memory-hub.service.ts's createGuestItem): one transaction, so a photo
  // never lands without the opt-in its guest asked for.
  withTransaction: <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => prisma.$transaction(fn),

  // ── Memory Hub ────────────────────────────

  findByEventId: (eventId: string, includeArchived = false) =>
    prisma.memoryHub.findFirst({
      where: { eventId, ...(includeArchived ? {} : { isArchived: false }) },
      include: {
        memoryItems: { where: { isArchived: false }, orderBy: { createdAt: 'desc' } },
      },
    }),

  findById: (id: string, includeArchived = false) =>
    prisma.memoryHub.findFirst({
      where: { id, ...(includeArchived ? {} : { isArchived: false }) },
      include: {
        memoryItems: { where: { isArchived: false }, orderBy: { createdAt: 'desc' } },
      },
    }),

  // Public share view — approved, non-archived items only, with just
  // enough uploader info to derive a display name (see
  // memory-hub.service.ts's toPublicItem). Event included (with
  // eventDays) so its effective status can be resolved before this goes
  // out to a guest's browser.
  findByShareToken: (shareToken: string) =>
    prisma.memoryHub.findFirst({
      where: { shareToken, isArchived: false },
      include: {
        event: { include: { eventDays: { where: { isArchived: false } } } },
        memoryItems: {
          where: { isArchived: false, status: 'APPROVED' },
          include: {
            uploadedByGuest: { select: { firstName: true } },
            uploadedByUser: { select: { username: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    }),

  create: (eventId: string, userId: string, data: CreateMemoryHubDto) =>
    prisma.memoryHub.create({
      data: {
        eventId,
        title: data.title ?? null,
        description: data.description ?? null,
        isPublic: false,
        shareToken: null,
        opensAt: data.opensAt ? parseClientDateTime(data.opensAt) : null,
        isArchived: false,
        createdBy: userId,
        updatedBy: userId,
      },
    }),

  update: (id: string, userId: string, data: UpdateMemoryHubDto) =>
    prisma.memoryHub.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title ?? null }),
        ...(data.description !== undefined && { description: data.description ?? null }),
        ...(data.opensAt !== undefined && { opensAt: data.opensAt ? parseClientDateTime(data.opensAt) : null }),
        updatedBy: userId,
      },
    }),

  // Generates (or regenerates, overwriting whatever was there) the
  // public share token — 32 random bytes as hex, matching
  // invite.repository.ts's token generation exactly (Task 4: "reuse
  // whatever mechanism already generates invite tokens"). Regenerating
  // invalidates the old link by construction: the column is
  // overwritten, so the previous value simply stops matching anything.
  generateShareToken: (id: string, userId: string) =>
    prisma.memoryHub.update({
      where: { id },
      data: {
        isPublic: true,
        shareToken: crypto.randomBytes(32).toString('hex'),
        updatedBy: userId,
      },
    }),

  revokeShareToken: (id: string, userId: string) =>
    prisma.memoryHub.update({
      where: { id },
      data: { isPublic: false, shareToken: null, updatedBy: userId },
    }),

  archive: (id: string, userId: string) =>
    prisma.memoryHub.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),

  reactivate: (id: string, userId: string) =>
    prisma.memoryHub.update({
      where: { id },
      data: { isArchived: false, updatedBy: userId },
    }),

  // ── Storage quota — summed on demand ──────
  //
  // PENDING + APPROVED count; REJECTED does not (Task 3 decision — see
  // the batch report). Archived items never count either way. This is
  // the ONLY source of truth for "how much storage is this event
  // using" — no running counter exists anywhere to drift out of sync.
  sumBytesForEvent: async (eventId: string): Promise<number> => {
    const result = await prisma.memoryItem.aggregate({
      where: {
        isArchived: false,
        status: { in: ['PENDING', 'APPROVED'] },
        memoryHub: { eventId },
      },
      _sum: { bytes: true },
    });
    return result._sum.bytes ?? 0;
  },

  // ── Memory Items ──────────────────────────

  // Same uploader join as findByShareToken above — curation needs to
  // know who uploaded something at least as well as an anonymous
  // visitor of the finished gallery does. Guest gets firstName only,
  // User gets username only — never email/phone; a display name is all
  // curation needs (see memory-hub.service.ts's toCuratedItem).
  findAllItems: (memoryHubId: string, status?: MemoryItemStatus, includeArchived = false) =>
    prisma.memoryItem.findMany({
      where: {
        memoryHubId,
        ...(includeArchived ? {} : { isArchived: false }),
        ...(status ? { status } : {}),
      },
      include: {
        uploadedByGuest: { select: { firstName: true } },
        uploadedByUser: { select: { username: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),

  // Contract B (guest-view) — myPendingItems. Filters by uploadedByGuestId
  // directly at the query level rather than fetching every pending item
  // and filtering in the service: a guest's request should never even
  // transit another guest's pending upload over the network, let alone
  // risk it leaking through a later refactor of the filter step.
  findPendingItemsByGuest: (memoryHubId: string, guestId: string) =>
    prisma.memoryItem.findMany({
      where: { memoryHubId, uploadedByGuestId: guestId, status: 'PENDING', isArchived: false },
      orderBy: { createdAt: 'desc' },
    }),

  // The guest's own live photos that can still be shown to them (pending
  // or approved; a rejected one is never shown to its guest), newest
  // first: guest-view's publicSharing.myItems. Filtered by uploader in the
  // query, like findPendingItemsByGuest.
  findShareablePhotosByGuest: (memoryHubId: string, guestId: string) =>
    prisma.memoryItem.findMany({
      where: {
        memoryHubId,
        uploadedByGuestId: guestId,
        mediaType: 'IMAGE',
        status: { in: ['PENDING', 'APPROVED'] },
        isArchived: false,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    }),

  // One live item this guest uploaded to this event, or null: the guest's
  // public-sharing toggle may only reach their own photo.
  findGuestItem: (id: string, eventId: string, guestId: string) =>
    prisma.memoryItem.findFirst({
      where: { id, memoryHub: { eventId }, uploadedByGuestId: guestId, isArchived: false },
      select: { id: true, mediaType: true },
    }),

  findItemById: (id: string, includeArchived = false) =>
    prisma.memoryItem.findFirst({
      where: { id, ...(includeArchived ? {} : { isArchived: false }) },
      include: {
        uploadedByGuest: { select: { firstName: true } },
        uploadedByUser: { select: { username: true } },
      },
    }),

  createItem: (
    memoryHubId: string,
    actorId: string,
    data: {
      mediaUrl: string;
      cloudinaryPublicId: string;
      mediaType: 'IMAGE' | 'VIDEO';
      bytes: number;
      caption?: string;
      status: MemoryItemStatus;
      uploadedByUserId?: string;
      uploadedByGuestId?: string;
    },
    tx?: Tx
  ) =>
    (tx ?? prisma).memoryItem.create({
      data: {
        memoryHubId,
        mediaUrl: data.mediaUrl,
        cloudinaryPublicId: data.cloudinaryPublicId,
        mediaType: data.mediaType,
        bytes: data.bytes,
        caption: data.caption ?? null,
        status: data.status,
        uploadedByUserId: data.uploadedByUserId ?? null,
        uploadedByGuestId: data.uploadedByGuestId ?? null,
        isArchived: false,
        createdBy: actorId,
        updatedBy: actorId,
      },
    }),

  updateItemCaption: (id: string, userId: string, caption: string | null | undefined) =>
    prisma.memoryItem.update({
      where: { id },
      data: {
        ...(caption !== undefined && { caption: caption ?? null }),
        updatedBy: userId,
      },
    }),

  // The only writer of MemoryItem.status — curateItem() in
  // memory-hub.service.ts is the sole caller. Kept separate from
  // updateItemCaption for the same reason Event.status has its own
  // updateStatus: a curation decision must never be smuggled through a
  // plain caption edit.
  updateItemStatus: (id: string, userId: string, status: MemoryItemStatus) =>
    prisma.memoryItem.update({
      where: { id },
      data: { status, updatedBy: userId },
    }),

  archiveItem: (id: string, userId: string) =>
    prisma.memoryItem.update({
      where: { id },
      data: { isArchived: true, updatedBy: userId },
    }),

  reactivateItem: (id: string, userId: string) =>
    prisma.memoryItem.update({
      where: { id },
      data: { isArchived: false, updatedBy: userId },
    }),
};
