import prisma from '../../shared/prisma/prisma.client.js';
import { type RegisterDto } from './auth.types.js';

export const authRepository = {

  // ─────────────────────────────────────────
  //  Find user by Firebase UID
  //  Used on every auth check
  // ─────────────────────────────────────────
  findUserByFirebaseUid: (firebaseUid: string) =>
    prisma.user.findUnique({
      where: { firebaseUid },
      include: { tenant: true },
    }),

  findUserByEmail: (email: string) =>
    prisma.user.findUnique({
      where: { email },
      include: { tenant: true },
    }),

  findTenantBySlug: (slug: string) =>
    prisma.tenant.findUnique({
      where: { slug },
    }),

  // ─────────────────────────────────────────
  //  Register — creates Tenant + User in one
  //  atomic transaction. If either fails,
  //  both are rolled back.
  // ─────────────────────────────────────────
  registerTenantAndAdmin: async (
    firebaseUid: string,
    email: string,
    data: RegisterDto
  ) =>
    prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: data.tenantName,
          slug: data.tenantSlug,
          email,
          subscriptionTier: 'SPARK',
          subscriptionStatus: 'ACTIVE',
          isArchived: false,
        },
      });

      const user = await tx.user.create({
        data: {
          firebaseUid,
          email,
          username: data.username,
          role: 'TENANT_ADMIN',
          tenantId: tenant.id,
          isActive: true,
          isArchived: false,
        },
      });

      return { user, tenant };
    }),

  // ─────────────────────────────────────────
  //  OTP management
  // ─────────────────────────────────────────

  // Invalidate any existing unused OTPs for
  // this user before creating a new one.
  // Prevents OTP accumulation in the table.
  invalidatePreviousOtps: (userId: string) =>
    prisma.otpRecord.updateMany({
      where: {
        userId,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        expiresAt: new Date(), // expire immediately
      },
    }),

  createOtp: (userId: string, otp: string) =>
    prisma.otpRecord.create({
      data: {
        userId,
        otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    }),

  findValidOtp: (userId: string, otp: string) =>
    prisma.otpRecord.findFirst({
      where: {
        userId,
        otp,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),

  markOtpAsUsed: (otpId: string) =>
    prisma.otpRecord.update({
      where: { id: otpId },
      data: { usedAt: new Date() },
    }),
};