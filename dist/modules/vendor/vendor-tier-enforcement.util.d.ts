import { type SubscriptionTier } from '@prisma/client';
import { type TenantSubscriptionState } from '../subscription/effective-tier.util.js';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
export interface VendorSpaceLimitInfo {
    limit: number | null;
    tenantTier: SubscriptionTier;
    vendorMarketplace: boolean;
}
export declare const resolveVendorSpaceLimit: (tenant: TenantSubscriptionState) => Promise<VendorSpaceLimitInfo>;
export declare const assertVendorSpaceCreatable: (tenantId: string | null) => Promise<void>;
export declare const assertVendorMarketplaceAccessible: (tenantId: string | null) => Promise<void>;
export declare const assertEventVendorMarketplaceAccessible: (event: EntitlementDerivableEvent) => Promise<void>;
//# sourceMappingURL=vendor-tier-enforcement.util.d.ts.map