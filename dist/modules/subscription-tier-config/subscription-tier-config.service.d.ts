import { type CreateSubscriptionTierConfigDto, type UpdateSubscriptionTierConfigDto } from './subscription-tier-config.type.js';
import { type SubscriptionTier } from '@prisma/client';
export declare const subscriptionTierConfigService: {
    getAll: () => import("@prisma/client").Prisma.PrismaPromise<{
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }[]>;
    getByTier: (tier: SubscriptionTier) => Promise<{
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }>;
    create: (data: CreateSubscriptionTierConfigDto) => Promise<{
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }>;
    update: (tier: SubscriptionTier, data: UpdateSubscriptionTierConfigDto) => Promise<{
        tier: import("@prisma/client").$Enums.SubscriptionTier;
        maxEvents: number | null;
        maxGuestsPerEvent: number | null;
        maxSmsPerMonth: number | null;
        emailEnabled: boolean;
        smsEnabled: boolean;
        vendorMarketplace: boolean;
        memoryHubEnabled: boolean;
        dragDropBuilder: boolean;
    }>;
};
//# sourceMappingURL=subscription-tier-config.service.d.ts.map