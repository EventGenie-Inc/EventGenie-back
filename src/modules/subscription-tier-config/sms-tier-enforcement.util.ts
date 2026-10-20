import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { eventPassRepository } from '../event-pass/event-pass.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEventEntitlement, isEventPassActive, type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { LAUNCH_CONTACT_EMAIL, launchLimitMessage, tierRefusalMessage } from './tier-refusal-wording.util.js';

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
      tierRefusalMessage(
        kind === 'invite'
          ? `The ${effectiveTier} plan doesn't include SMS, and ${batchSmsCount} guest(s) in this batch ` +
              `only have a phone number. Add an email address for them, or upgrade the plan.`
          : `The ${effectiveTier} plan doesn't include SMS, and ${batchSmsCount} guest(s) in this batch ` +
              `only have a phone number, so nothing was sent. Add an email address for them, or upgrade the plan.`,
        `SMS isn't available during your free trial, and ${batchSmsCount} guest(s) in this batch only have a ` +
          `phone number, so ${kind === 'invite' ? 'they cannot be invited' : 'nothing was sent'}. ` +
          `Add an email address for them, or contact us at ${LAUNCH_CONTACT_EMAIL} if you need SMS.`
      )
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
        tierRefusalMessage(
          `This event's SMS bundle has ${Math.max(remaining, 0)} credit(s) left, but this batch needs ` +
            `${batchSmsCount}. Buy more SMS credits for this event, since it doesn't use the monthly allowance.`,
          launchLimitMessage(
            `Nothing was sent, because this batch needs ${batchSmsCount} SMS message(s) and this event ` +
              `has ${Math.max(remaining, 0)} left`
          )
        )
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
        tierRefusalMessage(
          kind === 'invite'
            ? `This batch needs ${batchSmsCount} SMS invite(s), but the ${effectiveTier} plan has ` +
                `${Math.max(remaining, 0)} of its ${config.maxSmsPerMonth} a month left. ` +
                `Reduce the batch, wait until next month, or upgrade the plan.`
            : `Nothing was sent, because this batch needs ${batchSmsCount} SMS message(s) and the ${effectiveTier} plan has ` +
                `${Math.max(remaining, 0)} of its ${config.maxSmsPerMonth} a month left. ` +
                `Remind fewer guests, wait until next month, or upgrade the plan.`,
          launchLimitMessage(
            `Nothing was sent, because this batch needs ${batchSmsCount} SMS message(s) and your account has ` +
              `${Math.max(remaining, 0)} of its ${config.maxSmsPerMonth} a month left`
          )
        )
      );
    }
  }
  return { source: 'QUOTA' };
};
