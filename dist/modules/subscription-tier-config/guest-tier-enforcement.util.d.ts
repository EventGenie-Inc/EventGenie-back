import { type EventPassTier, type SubscriptionTier } from '@prisma/client';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
export interface GuestLimitInfo {
    limit: number | null;
    tenantTier: SubscriptionTier;
    tenantLimit: number | null;
    passTier: EventPassTier | null;
    passActive: boolean;
    passCap: number | null;
    boundByPass: boolean;
}
export declare const resolveGuestLimit: (event: EntitlementDerivableEvent & {
    id: string;
}) => Promise<GuestLimitInfo>;
export declare const assertGuestsCreatable: (event: EntitlementDerivableEvent & {
    id: string;
}, additionalCount: number) => Promise<void>;
//# sourceMappingURL=guest-tier-enforcement.util.d.ts.map