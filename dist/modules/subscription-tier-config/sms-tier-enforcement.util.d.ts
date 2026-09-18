import { type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
export type SmsSendPool = 'QUOTA' | 'BUNDLE';
export declare const assertSmsSendable: (event: EntitlementDerivableEvent & {
    id: string;
}, batchSmsCount: number) => Promise<{
    source: SmsSendPool;
}>;
//# sourceMappingURL=sms-tier-enforcement.util.d.ts.map