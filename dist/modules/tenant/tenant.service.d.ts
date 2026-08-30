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
    getById: (id: string, includeArchived?: boolean) => Promise<{
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
    getEvents: (id: string) => Promise<({
        eventDays: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            label: string;
            date: Date;
            startTime: Date | null;
            endTime: Date | null;
        }[];
    } & {
        name: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        description: string | null;
        location: string;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal | null;
        longitude: import("@prisma/client-runtime-utils").Decimal | null;
        coverImageUrl: string | null;
        coverImagePublicId: string | null;
        status: import("@prisma/client").$Enums.EventStatus;
        visibility: import("@prisma/client").$Enums.EventVisibility;
        ticketing: import("@prisma/client").$Enums.EventTicketing;
        invitationTemplate: string | null;
        invitationConfig: string | null;
        rsvpDeadline: Date | null;
        capacity: number | null;
        createdBy: string;
        updatedBy: string;
    })[]>;
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