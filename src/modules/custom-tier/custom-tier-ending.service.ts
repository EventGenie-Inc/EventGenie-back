import { sendEmail } from '../../shared/messaging/email.engine.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { customTierRepository } from './custom-tier.repository.js';
import { buildCustomTierEndingEmail } from './custom-tier-email.util.js';

// ─────────────────────────────────────────
//  "YOUR PLAN ENDS IN 7 DAYS" (STEERING "Custom tiers")
//
//  A tenant whose custom tier has an end date is emailed once, 7 days
//  before it (at the organisation's address, Tenant.email). The end itself
//  needs no job: the plan is worked out when read (effective-plan.util.ts),
//  so the tenant is on Spark the moment the date passes, whether or not
//  this sweep ever ran.
//
//  A periodic in-process sweep (startCustomTierSweeps, started by
//  server.ts), like the media-retention one. Claimed once per assignment
//  and end date (customTierEndingNoticeSentAt, cleared when either
//  changes), BEFORE sending, so two sweeps never both send; a send that
//  fails is logged and not retried (the end date still applies). An
//  assignment made less than 7 days before its end is emailed on the next
//  sweep.
// ─────────────────────────────────────────

export const CUSTOM_TIER_ENDING_NOTICE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const CUSTOM_TIER_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const CUSTOM_TIER_SWEEP_FIRST_RUN_DELAY_MS = 3 * 60 * 1000;

export const customTierEndingService = {
  // `tenantIds`: only these (tests run it scoped to their own tenants).
  sweep: async (now: Date = new Date(), { tenantIds }: { tenantIds?: string[] } = {}): Promise<{ sent: number; failed: number }> => {
    const ending = await customTierRepository.findEndingSoon(now, new Date(now.getTime() + CUSTOM_TIER_ENDING_NOTICE_DAYS * DAY_MS));
    let sent = 0;
    let failed = 0;
    for (const tenant of ending) {
      if (tenantIds && !tenantIds.includes(tenant.id)) continue;
      if (!tenant.customTierEndsAt || !tenant.customTier) continue;
      if (!(await customTierRepository.claimEndingNotice(tenant.id, tenant.customTierEndsAt, now))) continue;
      const result = await sendEmail(
        buildCustomTierEndingEmail({
          to: tenant.email,
          organisationName: tenant.name,
          tierName: tenant.customTier.name,
          endsAt: tenant.customTierEndsAt,
        })
      );
      if (result.ok) sent++;
      else {
        failed++;
        console.error(`[custom tiers] the ending email to tenant ${tenant.id} failed: ${result.reason}`);
      }
    }
    return { sent, failed };
  },
};

export const startCustomTierSweeps = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await customTierEndingService.sweep();
    } catch (err) {
      console.error('[custom tiers] sweep failed:', err);
      reportError(err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), CUSTOM_TIER_SWEEP_FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), CUSTOM_TIER_SWEEP_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
