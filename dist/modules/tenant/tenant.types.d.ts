import { type SubscriptionTier, type SubscriptionStatus } from '@prisma/client';
export interface CreateTenantDto {
    name: string;
    slug: string;
    email: string;
    subscriptionTier?: SubscriptionTier;
}
export interface UpdateTenantDto {
    name?: string;
    email?: string;
    subscriptionTier?: SubscriptionTier;
    subscriptionStatus?: SubscriptionStatus;
}
//# sourceMappingURL=tenant.types.d.ts.map