import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { eventPassRepository } from '../event-pass/event-pass.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEventEntitlement, isEventPassActive, type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';

// ─────────────────────────────────────────
//  SMS — TWO SEPARATE ACCOUNTING SYSTEMS, NEVER POOLED.
//
//  Subscription SMS is a monthly, TENANT-WIDE quota that resets
//  (SubscriptionTierConfig.maxSmsPerMonth, counted via
//  smsSendLogRepository.countForTenantThisMonth). Pass SMS is a
//  PER-EVENT bundle that does NOT reset (EventSmsBundlePurchase, summed
//  via eventPassRepository.sumPaidBundleSmsForEvent, minus already-used
//  BUNDLE-sourced sends via smsSendLogRepository.countBundleUsedForEvent).
//
//  An event WITH an active pass draws ONLY from its own bundle. An event
//  WITHOUT one draws ONLY from the tenant's monthly quota. This function
//  is the fork point: it decides which pool applies and enforces THAT
//  ONE, never falling back to the other in either direction — an
//  exhausted bundle refuses outright rather than quietly spending the
//  tenant's subscription allowance, and a subscription event never
//  drains a bundle it was never buying against. The returned `source`
//  is threaded by the caller (invite-dispatch.service.ts) into every
//  SmsSendLog row this batch actually sends, which is what makes the
//  separation a real, auditable fact rather than just documented intent.
// ─────────────────────────────────────────

export type SmsSendPool = 'QUOTA' | 'BUNDLE';

// Which kind of message the batch is — affects only the WORDING of a
// refusal (a reminder refusal must not talk about "invites"), never which
// pool is drawn from or how much. Invitations and reminders are both just
// SMS to the quota and the bundle: they share one allowance / one bundle.
export type SmsBatchKind = 'invite' | 'reminder';

// EVENT-SCOPED (Event Pass batch) — takes the full fetched event, not a
// bare tenantId, so a missed call site fails to compile rather than
// falling back to tenant-only (quota-only) resolution. Both the
// bulk-send endpoint and resend share this one check, mirroring
// assertGuestsCreatable's shape.
export const assertSmsSendable = async (
  event: EntitlementDerivableEvent & { id: string },
  batchSmsCount: number,
  kind: SmsBatchKind = 'invite'
): Promise<{ source: SmsSendPool }> => {
  if (batchSmsCount === 0) return { source: 'QUOTA' };

  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

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
    throw new HttpError(
      403,
      kind === 'invite'
        ? `The ${effectiveTier} plan does not include SMS invites. ` +
            `${batchSmsCount} guest(s) in this batch only have a phone number on file and cannot be ` +
            `invited by SMS. Add an email address for these guests, or upgrade the plan to enable SMS.`
        : `The ${effectiveTier} plan does not include SMS. ` +
            `${batchSmsCount} guest(s) in this batch only have a phone number on file and cannot be ` +
            `reminded by SMS. Nothing was sent. Add an email address for these guests, or upgrade the plan to enable SMS.`
    );
  }

  if (isEventPassActive(event)) {
    // BUNDLE pool — this event has an active pass. Never reads
    // maxSmsPerMonth or the tenant's monthly count at all.
    const purchased = await eventPassRepository.sumPaidBundleSmsForEvent(event.id);
    const used = await smsSendLogRepository.countBundleUsedForEvent(event.id);
    const remaining = purchased - used;

    if (batchSmsCount > remaining) {
      throw new HttpError(
        403,
        `This event's SMS bundle has ${Math.max(remaining, 0)} credit(s) left, but this batch needs ` +
          `${batchSmsCount}. Buy more SMS credits for this event to continue — it does not draw from ` +
          `the account's monthly SMS allowance.`
      );
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
      throw new HttpError(
        403,
        kind === 'invite'
          ? `The ${effectiveTier} plan allows ${config.maxSmsPerMonth} SMS invite(s) per month. ` +
              `${usedThisMonth} have already been sent this month, leaving ${Math.max(remaining, 0)} remaining ` +
              `— this batch needs ${batchSmsCount}. Reduce the batch, wait until next month, or upgrade the plan.`
          : `The ${effectiveTier} plan allows ${config.maxSmsPerMonth} SMS message(s) per month, shared by invitations and ` +
              `reminders. ${usedThisMonth} have already been sent this month, leaving ${Math.max(remaining, 0)} remaining ` +
              `— this batch needs ${batchSmsCount}. Nothing was sent. Remind fewer guests, wait until next month, or upgrade the plan.`
      );
    }
  }
  return { source: 'QUOTA' };
};
