import prisma from '../../shared/prisma/prisma.client.js';
import { type PlatformRole } from '@prisma/client';

// TeamInvite rows: invitations to join a tenant (user-invite.service.ts).
// Prisma queries only. Every by-id read takes the tenant it must belong to.
// Only tokenHash is ever stored or queried; the raw token never reaches
// this file.

const inviteInclude = {
  invitedBy: { select: { id: true, username: true } },
} as const;

export const userInviteRepository = {

  // Open = not accepted and not revoked (expired ones included: the admin
  // resends those). Newest first.
  findOpenForTenant: (tenantId: string) =>
    prisma.teamInvite.findMany({
      where: { tenantId, acceptedAt: null, revokedAt: null },
      include: inviteInclude,
      orderBy: { createdAt: 'desc' },
    }),

  findOpenForTenantAndEmail: (tenantId: string, email: string) =>
    prisma.teamInvite.findFirst({ where: { tenantId, email, acceptedAt: null, revokedAt: null } }),

  findById: (id: string, tenantId: string) =>
    prisma.teamInvite.findFirst({ where: { id, tenantId }, include: inviteInclude }),

  // The public lookup/accept path: the tenant comes from the invite itself.
  findByTokenHash: (tokenHash: string) =>
    prisma.teamInvite.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { id: true, name: true, isArchived: true } } },
    }),

  create: (data: {
    tenantId: string;
    email: string;
    role: PlatformRole;
    eventIds: string[];
    tokenHash: string;
    expiresAt: Date;
    invitedByUserId: string;
  }) =>
    prisma.teamInvite.create({
      data: { ...data, lastSentAt: new Date() },
      include: inviteInclude,
    }),

  // Resend: a new token (the old link stops matching) and a new expiry.
  // Only an open invite is rotated; the caller checked, and the where
  // clause re-checks so a concurrent accept/revoke can't be undone.
  rotateToken: async (id: string, tokenHash: string, expiresAt: Date) => {
    const { count } = await prisma.teamInvite.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { tokenHash, expiresAt, lastSentAt: new Date() },
    });
    return count === 1;
  },

  revoke: (id: string) =>
    prisma.teamInvite.update({ where: { id }, data: { revokedAt: new Date() }, include: inviteInclude }),

  findTenantName: (tenantId: string) =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),

  // Live (non-archived) events of this tenant among ids — what an invite's
  // or a member's assignments may name.
  findLiveEventsInTenant: (tenantId: string, ids: string[]) =>
    prisma.event.findMany({
      where: { tenantId, isArchived: false, id: { in: ids } },
      select: { id: true, name: true },
    }),

  // ACCEPT, in one transaction: claim the invite (single use — the
  // conditional update only matches an open, unexpired invite, so two
  // simultaneous accepts can't both succeed), create the user in the
  // inviting tenant, and create their assignments. Throws whatever Prisma
  // throws (the service maps a unique-email violation to 409).
  accept: (input: {
    inviteId: string;
    tenantId: string;
    firebaseUid: string;
    email: string;
    username: string;
    role: PlatformRole;
    eventIds: string[];
    invitedByUserId: string;
  }) =>
    prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.teamInvite.updateMany({
        where: { id: input.inviteId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (count !== 1) return null;

      const user = await tx.user.create({
        data: {
          firebaseUid: input.firebaseUid,
          email: input.email,
          username: input.username,
          role: input.role,
          tenantId: input.tenantId,
          isActive: true,
          isArchived: false,
        },
      });

      if (input.eventIds.length) {
        await tx.eventAssignment.createMany({
          data: input.eventIds.map((eventId) => ({
            tenantId: input.tenantId,
            userId: user.id,
            eventId,
            createdBy: input.invitedByUserId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.teamInvite.update({ where: { id: input.inviteId }, data: { acceptedUserId: user.id } });
      return user;
    }),
};
