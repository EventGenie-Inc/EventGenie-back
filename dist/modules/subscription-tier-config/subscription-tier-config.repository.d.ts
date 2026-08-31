import { type CreateSubscriptionTierConfigDto, type UpdateSubscriptionTierConfigDto } from './subscription-tier-config.type.js';
import { type SubscriptionTier } from '@prisma/client';
export declare const subscriptionTierConfigRepository: {
    findAll: () => import("@prisma/client").Prisma.PrismaPromise<{
        updatedAt: Date;
        isAvailable: boolean;
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        maxVendorSpaces: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }[]>;
    findByTier: (tier: SubscriptionTier) => import("@prisma/client").Prisma.Prisma__SubscriptionTierConfigClient<{
        updatedAt: Date;
        isAvailable: boolean;
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        maxVendorSpaces: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    create: (data: CreateSubscriptionTierConfigDto) => import("@prisma/client").Prisma.Prisma__SubscriptionTierConfigClient<{
        updatedAt: Date;
        isAvailable: boolean;
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        maxVendorSpaces: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (tier: SubscriptionTier, data: UpdateSubscriptionTierConfigDto) => import("@prisma/client").Prisma.Prisma__SubscriptionTierConfigClient<{
        updatedAt: Date;
        isAvailable: boolean;
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        maxVendorSpaces: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    setAvailability: (tier: SubscriptionTier, isAvailable: boolean) => import("@prisma/client").Prisma.Prisma__SubscriptionTierConfigClient<{
        updatedAt: Date;
        isAvailable: boolean;
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        maxVendorSpaces: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=subscription-tier-config.repository.d.ts.map