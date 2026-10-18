import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

// The photos feedback can ever involve: approved, live photos a GUEST
// uploaded to the event's live album. Whether each is eligible or
// shareable also depends on consent, decided in feedback-photos.util.ts.
// Organiser uploads have no guest opt-in, so they are never among them.
const guestPhotoWhere = (eventIds: string[]): Prisma.MemoryItemWhereInput => ({
  memoryHub: { eventId: { in: eventIds }, isArchived: false },
  status: 'APPROVED',
  isArchived: false,
  mediaType: 'IMAGE',
  uploadedByGuestId: { not: null },
});

const GUEST_PHOTO_SELECT = {
  id: true,
  mediaUrl: true,
  cloudinaryPublicId: true,
  bytes: true,
  caption: true,
  createdAt: true,
  memoryHub: { select: { eventId: true } },
  uploadedByGuest: { select: { firstName: true } },
} as const;

export const feedbackRepository = {

  // ── Feedback ──────────────────────────────

  findByEventId: (eventId: string, db: Db = prisma) =>
    db.eventFeedback.findFirst({ where: { eventId, isArchived: false } }),

  // Which of these events have feedback — one query for a whole list
  // (GET /api/events' feedbackGiven), never one per event.
  findEventIdsWithFeedback: async (eventIds: string[]): Promise<Set<string>> => {
    if (eventIds.length === 0) return new Set();
    const rows = await prisma.eventFeedback.findMany({
      where: { eventId: { in: eventIds }, isArchived: false },
      select: { eventId: true },
    });
    return new Set(rows.map((r) => r.eventId));
  },

  // Serialises saves of one event's feedback, so two organisers saving at
  // once can't both record the same change of permission. Same row-lock
  // idiom as announcement.repository.ts's withEventAnnouncementLock.
  withEventFeedbackLock: <T>(eventId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
        return fn(tx);
      },
      { maxWait: 10_000, timeout: 15_000 }
    ),

  create: (
    data: {
      eventId: string;
      tenantId: string;
      score: number;
      workedBest: string | null;
      toImprove: string | null;
      logoUrl: string | null;
      logoPublicId: string | null;
      userId: string;
    },
    tx: Tx
  ) =>
    tx.eventFeedback.create({
      data: {
        eventId: data.eventId,
        tenantId: data.tenantId,
        score: data.score,
        workedBest: data.workedBest,
        toImprove: data.toImprove,
        logoUrl: data.logoUrl,
        logoPublicId: data.logoPublicId,
        submittedBy: data.userId,
        updatedBy: data.userId,
      },
    }),

  update: (
    id: string,
    userId: string,
    data: {
      score?: number;
      workedBest?: string | null;
      toImprove?: string | null;
      logoUrl?: string | null;
      logoPublicId?: string | null;
    },
    tx: Tx
  ) =>
    tx.eventFeedback.update({
      where: { id },
      data: {
        ...(data.score !== undefined && { score: data.score }),
        ...(data.workedBest !== undefined && { workedBest: data.workedBest }),
        ...(data.toImprove !== undefined && { toImprove: data.toImprove }),
        ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
        ...(data.logoPublicId !== undefined && { logoPublicId: data.logoPublicId }),
        updatedBy: userId,
      },
    }),

  // Super admin: every live feedback, newest change first, with what the
  // list shows of its event and company.
  findAllWithEvent: () =>
    prisma.eventFeedback.findMany({
      where: { isArchived: false },
      orderBy: { updatedAt: 'desc' },
      include: {
        tenant: { select: { name: true } },
        event: {
          select: {
            id: true,
            name: true,
            eventDays: { where: { isArchived: false }, select: { date: true }, orderBy: { date: 'asc' } },
          },
        },
      },
    }),

  // ── Photos ────────────────────────────────

  findApprovedGuestPhotos: (eventIds: string[], db: Db = prisma) =>
    eventIds.length === 0
      ? Promise.resolve([])
      : db.memoryItem.findMany({ where: guestPhotoWhere(eventIds), select: GUEST_PHOTO_SELECT, orderBy: { createdAt: 'asc' } }),

  // ── The "How did it go?" email ────────────

  // Events whose last live day falls between the two dates (inclusive,
  // 'YYYY-MM-DD', UTC), published (so neither a draft nor CANCELLED), not
  // archived, in a live tenant, with no feedback and never asked. The
  // caller still confirms each is COMPLETED (resolveEffectiveStatus) before
  // claiming it.
  findFeedbackRequestCandidates: async (lastDayFrom: string, lastDayTo: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id"
      FROM "Event" e
      JOIN "Tenant" t ON t."id" = e."tenantId"
      WHERE e."status" = 'PUBLISHED'::"EventStatus"
        AND e."isArchived" = false
        AND t."isArchived" = false
        AND NOT EXISTS (SELECT 1 FROM "EventFeedback" f WHERE f."eventId" = e."id")
        AND NOT EXISTS (SELECT 1 FROM "FeedbackRequestClaim" c WHERE c."eventId" = e."id")
        AND (
          SELECT max(d."date") FROM "EventDay" d WHERE d."eventId" = e."id" AND d."isArchived" = false
        ) BETWEEN ${lastDayFrom}::date AND ${lastDayTo}::date
      ORDER BY e."id"
    `;
    return rows.map((r) => r.id);
  },

  findEventForFeedbackRequest: (eventId: string) =>
    prisma.event.findFirst({
      where: { id: eventId, isArchived: false },
      select: {
        id: true,
        tenantId: true,
        name: true,
        status: true,
        createdByUserId: true,
        eventDays: { where: { isArchived: false }, select: { date: true, endTime: true } },
        assignments: {
          select: { user: { select: { id: true, email: true, username: true, role: true, tenantId: true, isActive: true, isArchived: true } } },
        },
        createdByUser: { select: { id: true, email: true, username: true, role: true, tenantId: true, isActive: true, isArchived: true } },
      },
    }),

  countAssignmentsForUser: (userId: string) => prisma.eventAssignment.count({ where: { userId } }),

  findActiveTenantAdmins: (tenantId: string) =>
    prisma.user.findMany({
      where: { tenantId, role: 'TENANT_ADMIN', isActive: true, isArchived: false },
      select: { id: true, email: true, username: true },
      orderBy: { createdAt: 'asc' },
    }),

  // The claim: one row per event, ever. Throws a unique violation when the
  // event was already claimed (by another sweep, here or on another server).
  createRequestClaim: (eventId: string, recipientCount: number) =>
    prisma.feedbackRequestClaim.create({ data: { eventId, recipientCount } }),
};
