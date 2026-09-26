import prisma from '../../shared/prisma/prisma.client.js';

// Prisma calls only — no business logic (STEERING.md's repository rule).
// Lookups take the already-hashed value; hashing itself lives in
// device-token.util.ts, which is also where "is this row actually still
// usable" (revoked? expired? right user?) gets decided.
export const deviceTokenRepository = {

  create: (userId: string, tokenHash: string, expiresAt: Date) =>
    prisma.deviceToken.create({
      data: { userId, tokenHash, expiresAt },
    }),

  findByHash: (tokenHash: string) =>
    prisma.deviceToken.findUnique({
      where: { tokenHash },
    }),

  touchLastUsed: (id: string) =>
    prisma.deviceToken.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    }),

  revoke: (id: string, reason: string) =>
    prisma.deviceToken.updateMany({
      // updateMany (not update), guarded by revokedAt: null, so revoking
      // an already-revoked row is a 0-row no-op instead of overwriting
      // the original revokedAt/revokedReason — the audit trail keeps
      // whichever reason revoked it FIRST.
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    }),

  // Bulk path — password reset and suspension revoke every device a user
  // has, not one. Same revokedAt:null guard, same reasoning.
  revokeAllForUser: (userId: string, reason: string) =>
    prisma.deviceToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    }),
};
