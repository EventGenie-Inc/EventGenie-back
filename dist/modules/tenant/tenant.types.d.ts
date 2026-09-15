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
//# sourceMappingURL=tenant.types.d.ts.map