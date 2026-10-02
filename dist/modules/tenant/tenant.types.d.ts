import { type SubscriptionTier, type SubscriptionStatus } from '@prisma/client';
export interface ClientTenantDto {
    id: string;
    name: string;
    slug: string;
    email: string;
    subscriptionTier: SubscriptionTier;
    subscriptionStatus: SubscriptionStatus;
    createdAt: Date;
}
export interface VendorSpaceLimitDto {
    limit: number | null;
    currentCount: number;
}
export interface ClientTenantDetailDto extends ClientTenantDto {
    vendorSpaceLimit: VendorSpaceLimitDto;
}
//# sourceMappingURL=tenant.types.d.ts.map