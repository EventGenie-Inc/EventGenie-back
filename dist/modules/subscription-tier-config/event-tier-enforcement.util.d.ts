import { type EventVisibility, type EventTicketing } from '@prisma/client';
export interface EventTierCheckInput {
    visibility?: EventVisibility;
    ticketing?: EventTicketing;
    hasCustomRsvpFields?: boolean;
}
export declare const assertEventCreatable: (tenantId: string, input: EventTierCheckInput) => Promise<void>;
export declare const assertEventUpdatable: (tenantId: string, input: EventTierCheckInput) => Promise<void>;
//# sourceMappingURL=event-tier-enforcement.util.d.ts.map