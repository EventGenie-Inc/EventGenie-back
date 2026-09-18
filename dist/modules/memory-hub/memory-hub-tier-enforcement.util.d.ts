import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
export declare const assertMemoryHubAccessible: (event: EntitlementDerivableEvent) => Promise<void>;
export declare const getMemoryHubQuotaBytes: (event: EntitlementDerivableEvent) => Promise<number | null>;
export declare const assertMemoryHubQuotaAvailable: (event: EntitlementDerivableEvent & {
    id: string;
}) => Promise<void>;
//# sourceMappingURL=memory-hub-tier-enforcement.util.d.ts.map