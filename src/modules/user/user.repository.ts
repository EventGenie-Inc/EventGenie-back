import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma, type PlatformRole } from '@prisma/client';
import { type CreateUserDto, type UpdateUserDto } from './user.types.js';

type Tx = Prisma.TransactionClient;

export const userRepository = {

  findAll: (tenantId?: string, includeArchived = false) =>
    prisma.user.findMany({
      where: {
        ...(includeArchived ? {} : { isArchived: false }),
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string, includeArchived = false, tenantId?: string) =>
    prisma.user.findFirst({
      where: {
        id,
        ...(includeArchived ? {} : { isArchived: false }),
        ...(tenantId ? { tenantId } : {}),
      },
    }),

  findByFirebaseUid: (firebaseUid: string) =>
    prisma.user.findUnique({
      where: { firebaseUid },
    }),

  // The longest-serving active TENANT_ADMIN of a tenant — the stand-in
  // Reply-To for an invitation whose creator can no longer be reached
  // (invite-dispatch.service.ts). Oldest first, so the choice is stable.
  findFirstActiveTenantAdmin: (tenantId: string) =>
    prisma.user.findFirst({
      where: { tenantId, role: 'TENANT_ADMIN', isActive: true, isArchived: false },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    }),

  findByEmail: (email: string) =>
    prisma.user.findFirst({
      where: { email, isArchived: false },
    }),

  create: (data: CreateUserDto) =>
    prisma.user.create({
      data: {
        firebaseUid: data.firebaseUid,
        email: data.email,
        username: data.username,
        role: data.role,
        tenantId: data.tenantId ?? null,
        isActive: true,
        isArchived: false,
      },
    }),

  // Only the fields UpdateUserDto names, each set explicitly. This used to
  // spread the request body straight into Prisma, so PUT /api/users/:id
  // could set tenantId, email, firebaseUid, isActive or isArchived.
  update: (id: string, data: UpdateUserDto, tx: Tx = prisma) =>
    tx.user.update({
      where: { id },
      data: {
        ...(data.username !== undefined && { username: data.username }),
        ...(data.role !== undefined && { role: data.role }),
        updatedAt: new Date(),
      },
    }),

  archive: (id: string, tx: Tx = prisma) =>
    tx.user.update({
      where: { id },
      data: { isArchived: true, isActive: false },
    }),

  // ── Team management (Team Members batch) ──

  // Every user in the tenant, suspended ones included: the team list is
  // where a TENANT_ADMIN reactivates someone, so it must show them.
  findAllForTeam: (tenantId: string) =>
    prisma.user.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),

  // Runs fn in a transaction holding a row lock on the tenant, so two
  // changes to the same tenant's admins can't interleave: without it, two
  // TENANT_ADMINs demoting or suspending each other at the same moment
  // would each see the other still active, and both would succeed.
  withTenantTeamLock: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
      return fn(tx);
    }),

  countOtherActiveWithRole: (tx: Tx, tenantId: string, role: PlatformRole, excludeUserId: string) =>
    tx.user.count({
      where: { tenantId, role, isActive: true, isArchived: false, id: { not: excludeUserId } },
    }),

  reactivate: (id: string) =>
    prisma.user.update({
      where: { id },
      data: { isArchived: false, isActive: true },
    }),
};