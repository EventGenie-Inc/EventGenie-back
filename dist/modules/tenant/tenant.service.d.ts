export declare const tenantService: {
    getAll: () => import("@prisma/client").Prisma.PrismaPromise<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
    }[]>;
    getById: (id: string) => Promise<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
    }>;
    getUsers: (id: string) => Promise<{
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
    }[]>;
    suspend: (id: string, superAdminUserId: string) => Promise<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
    } | null>;
    reactivate: (id: string, superAdminUserId: string) => Promise<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
    } | null>;
};
//# sourceMappingURL=tenant.service.d.ts.map