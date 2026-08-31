import { type SubscriptionTier } from '@prisma/client';
export interface CreateSubscriptionTierConfigDto {
    tier: SubscriptionTier;
    maxEvents?: number;
    maxGuestsPerEvent?: number;
    maxSmsPerMonth?: number;
    maxVendorSpaces?: number;
    emailEnabled: boolean;
    smsEnabled: boolean;
    vendorMarketplace: boolean;
    memoryHubEnabled: boolean;
    dragDropBuilder: boolean;
}
export interface UpdateSubscriptionTierConfigDto {
    maxEvents?: number;
    maxGuestsPerEvent?: number;
    maxSmsPerMonth?: number;
    maxVendorSpaces?: number;
    emailEnabled?: boolean;
    smsEnabled?: boolean;
    vendorMarketplace?: boolean;
    memoryHubEnabled?: boolean;
    dragDropBuilder?: boolean;
    isAvailable?: boolean;
}
//# sourceMappingURL=subscription-tier-config.type.d.ts.map