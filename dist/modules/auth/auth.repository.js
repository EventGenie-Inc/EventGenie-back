import prisma from '../../shared/prisma/prisma.client.js';
import {} from './auth.types.js';
export const authRepository = {
    // ─────────────────────────────────────────
    //  Find user by Firebase UID
    //  Used on every auth check
    // ─────────────────────────────────────────
    findUserByFirebaseUid: (firebaseUid) => prisma.user.findUnique({
        where: { firebaseUid },
        include: { tenant: true },
    }),
    findUserByEmail: (email) => prisma.user.findUnique({
        where: { email },
        include: { tenant: true },
    }),
    findTenantBySlug: (slug) => prisma.tenant.findUnique({
        where: { slug },
    }),
    // ─────────────────────────────────────────
    //  Register — creates Tenant + User in one
    //  atomic transaction. If either fails,
    //  both are rolled back.
    // ─────────────────────────────────────────
    registerTenantAndAdmin: async (firebaseUid, email, data) => prisma.$transaction(async (tx) => {
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
    invalidatePreviousOtps: (userId) => prisma.otpRecord.updateMany({
        where: {
            userId,
            usedAt: null,
            expiresAt: { gt: new Date() },
        },
        data: {
            expiresAt: new Date(), // expire immediately
        },
    }),
    createOtp: (userId, otp) => prisma.otpRecord.create({
        data: {
            userId,
            otp,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
    }),
    findValidOtp: (userId, otp) => prisma.otpRecord.findFirst({
        where: {
            userId,
            otp,
            usedAt: null,
            expiresAt: { gt: new Date() },
        },
    }),
    markOtpAsUsed: (otpId) => prisma.otpRecord.update({
        where: { id: otpId },
        data: { usedAt: new Date() },
    }),
};
//# sourceMappingURL=auth.repository.js.map