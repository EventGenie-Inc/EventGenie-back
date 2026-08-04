import { type RegisterDto } from './auth.types.js';
export declare const authRepository: {
    findUserByFirebaseUid: (firebaseUid: string) => import("@prisma/client").Prisma.Prisma__UserClient<({
        tenant: {
            name: string;
            id: string;
            slug: string;
            email: string;
            subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
            subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
        } | null;
    } & {
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findUserByEmail: (email: string) => import("@prisma/client").Prisma.Prisma__UserClient<({
        tenant: {
            name: string;
            id: string;
            slug: string;
            email: string;
            subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
            subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
        } | null;
    } & {
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findTenantBySlug: (slug: string) => import("@prisma/client").Prisma.Prisma__TenantClient<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    registerTenantAndAdmin: (firebaseUid: string, email: string, data: RegisterDto) => Promise<{
        user: {
            id: string;
            email: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string | null;
            vendorSpaceId: string | null;
            firebaseUid: string;
            username: string;
            role: import("@prisma/client").$Enums.PlatformRole;
            isActive: boolean;
        };
        tenant: {
            name: string;
            id: string;
            slug: string;
            email: string;
            subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
            subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
        };
    }>;
    invalidatePreviousOtps: (userId: string) => import("@prisma/client").Prisma.PrismaPromise<import("@prisma/client").Prisma.BatchPayload>;
    createOtp: (userId: string, otp: string) => import("@prisma/client").Prisma.Prisma__OtpRecordClient<{
        id: string;
        createdAt: Date;
        userId: string;
        otp: string;
        expiresAt: Date;
        usedAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findValidOtp: (userId: string, otp: string) => import("@prisma/client").Prisma.Prisma__OtpRecordClient<{
        id: string;
        createdAt: Date;
        userId: string;
        otp: string;
        expiresAt: Date;
        usedAt: Date | null;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    markOtpAsUsed: (otpId: string) => import("@prisma/client").Prisma.Prisma__OtpRecordClient<{
        id: string;
        createdAt: Date;
        userId: string;
        otp: string;
        expiresAt: Date;
        usedAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=auth.repository.d.ts.map