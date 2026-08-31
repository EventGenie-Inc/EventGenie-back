export declare const tenantRepository: {
    findAll: () => import("@prisma/client").Prisma.PrismaPromise<{
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
    findById: (id: string, includeArchived?: boolean) => import("@prisma/client").Prisma.Prisma__TenantClient<{
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
    findBySlug: (slug: string) => import("@prisma/client").Prisma.Prisma__TenantClient<{
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
    suspend: (id: string) => import("@prisma/client").Prisma.Prisma__TenantClient<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    reactivate: (id: string) => import("@prisma/client").Prisma.Prisma__TenantClient<{
        name: string;
        id: string;
        slug: string;
        email: string;
        subscriptionTier: import("@prisma/client").$Enums.SubscriptionTier;
        subscriptionStatus: import("@prisma/client").$Enums.SubscriptionStatus;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findAllUsersByTenant: (tenantId: string, includeArchived?: boolean) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }[]>;
};
//# sourceMappingURL=tenant.repository.d.ts.map