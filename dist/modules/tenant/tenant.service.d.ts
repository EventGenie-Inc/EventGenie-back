import { type CreateTenantDto, type UpdateTenantDto } from './tenant.types.js';
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
    create: (data: CreateTenantDto) => Promise<{
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
    update: (id: string, data: UpdateTenantDto) => Promise<{
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
    archive: (id: string) => Promise<{
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
};
//# sourceMappingURL=tenant.service.d.ts.map