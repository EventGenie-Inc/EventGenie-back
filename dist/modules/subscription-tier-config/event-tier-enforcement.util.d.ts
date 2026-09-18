import { type EventVisibility, type EventTicketing } from '@prisma/client';
import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
export interface EventTierCheckInput {
    visibility?: EventVisibility;
    ticketing?: EventTicketing;
    hasCustomRsvpFields?: boolean;
}
export declare const assertEventCreatable: (tenantId: string, input: EventTierCheckInput) => Promise<void>;
export declare const assertEventUpdatable: (event: EntitlementDerivableEvent, input: EventTierCheckInput) => Promise<void>;
//# sourceMappingURL=event-tier-enforcement.util.d.ts.map