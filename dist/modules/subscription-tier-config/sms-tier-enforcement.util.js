import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { eventPassRepository } from '../event-pass/event-pass.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEventEntitlement, isEventPassActive } from '../event-pass/event-entitlement.util.js';
// EVENT-SCOPED (Event Pass batch) — takes the full fetched event, not a
// bare tenantId, so a missed call site fails to compile rather than
// falling back to tenant-only (quota-only) resolution. Both the
// bulk-send endpoint and resend share this one check, mirroring
// assertGuestsCreatable's shape.
export const assertSmsSendable = async (event, batchSmsCount) => {
    if (batchSmsCount === 0)
        return { source: 'QUOTA' };
    const tenant = await tenantRepository.findById(event.tenantId);
    if (!tenant)
        throw new HttpError(404, 'Tenant not found');
    // Rule A is gated on smsEnabled, NOT on tier name or maxSmsPerMonth.
    // This is necessary, not stylistic: seeded SPARK config has
    // maxSmsPerMonth: null (which the codebase's own "null = unlimited"
    // convention, used below for Rule B, would misread as permissive) but
    // smsEnabled: false. Reading smsEnabled first is what makes Spark
    // correctly blocked despite the null limit, and is what lets a
    // SUPER_ADMIN's live tier-config edits take effect immediately with no
    // hardcoded tier check anywhere. ACTION-time (dispatching NEW sms): an
    // already-delivered invite still resolves regardless of this check;
    // only sending MORE is gated on the event's current entitlement.
    const effectiveTier = resolveEventEntitlement(tenant, event);
    const config = await subscriptionTierConfigRepository.findByTier(effectiveTier);
    if (!config?.smsEnabled) {
        throw new HttpError(403, `The ${effectiveTier} plan does not include SMS invites. ` +
            `${batchSmsCount} guest(s) in this batch only have a phone number on file and cannot be ` +
            `invited by SMS. Add an email address for these guests, or upgrade the plan to enable SMS.`);
    }
    if (isEventPassActive(event)) {
        // BUNDLE pool — this event has an active pass. Never reads
        // maxSmsPerMonth or the tenant's monthly count at all.
        const purchased = await eventPassRepository.sumPaidBundleSmsForEvent(event.id);
        const used = await smsSendLogRepository.countBundleUsedForEvent(event.id);
        const remaining = purchased - used;
        if (batchSmsCount > remaining) {
            throw new HttpError(403, `This event's SMS bundle has ${Math.max(remaining, 0)} credit(s) left, but this batch needs ` +
                `${batchSmsCount}. Buy more SMS credits for this event to continue — it does not draw from ` +
                `the account's monthly SMS allowance.`);
        }
        return { source: 'BUNDLE' };
    }
    // QUOTA pool — no active pass on this event, unchanged monthly-tenant
    // logic. null = unlimited (Elevate's case) — only reached once
    // smsEnabled is true.
    if (config.maxSmsPerMonth != null) {
        const usedThisMonth = await smsSendLogRepository.countForTenantThisMonth(event.tenantId);
        const remaining = config.maxSmsPerMonth - usedThisMonth;
        if (batchSmsCount > remaining) {
            throw new HttpError(403, `The ${effectiveTier} plan allows ${config.maxSmsPerMonth} SMS invite(s) per month. ` +
                `${usedThisMonth} have already been sent this month, leaving ${Math.max(remaining, 0)} remaining ` +
                `— this batch needs ${batchSmsCount}. Reduce the batch, wait until next month, or upgrade the plan.`);
        }
    }
    return { source: 'QUOTA' };
};
//# sourceMappingURL=sms-tier-enforcement.util.js.map