import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
// Called before any dispatch begins on a batch that includes SMS-bound
// invites — both the bulk-send endpoint and resend share this one check,
// mirroring assertGuestsCreatable's shape exactly.
//
// Rule A is gated on smsEnabled, NOT on tier name or maxSmsPerMonth. This
// is necessary, not stylistic: seeded SPARK config has maxSmsPerMonth: null
// (which the codebase's own "null = unlimited" convention, used below for
// Rule B, would misread as permissive) but smsEnabled: false. Reading
// smsEnabled first is what makes Spark correctly blocked despite the null
// limit, and is what lets a SUPER_ADMIN's live tier-config edits take
// effect immediately with no hardcoded tier check anywhere.
export const assertSmsSendable = async (eventTenantId, batchSmsCount) => {
    if (batchSmsCount === 0)
        return;
    const tenant = await tenantRepository.findById(eventTenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    const config = await subscriptionTierConfigRepository.findByTier(tenant.subscriptionTier);
    if (!config?.smsEnabled) {
        throw new HttpError(403, `The ${tenant.subscriptionTier} plan does not include SMS invites. ` +
            `${batchSmsCount} guest(s) in this batch only have a phone number on file and cannot be ` +
            `invited by SMS. Add an email address for these guests, or upgrade the plan to enable SMS.`);
    }
    // null = unlimited (Elevate's case) — only reached once smsEnabled is true.
    if (config.maxSmsPerMonth != null) {
        const usedThisMonth = await smsSendLogRepository.countForTenantThisMonth(eventTenantId);
        const remaining = config.maxSmsPerMonth - usedThisMonth;
        if (batchSmsCount > remaining) {
            throw new HttpError(403, `The ${tenant.subscriptionTier} plan allows ${config.maxSmsPerMonth} SMS invite(s) per month. ` +
                `${usedThisMonth} have already been sent this month, leaving ${Math.max(remaining, 0)} remaining ` +
                `— this batch needs ${batchSmsCount}. Reduce the batch, wait until next month, or upgrade the plan.`);
        }
    }
};
//# sourceMappingURL=sms-tier-enforcement.util.js.map