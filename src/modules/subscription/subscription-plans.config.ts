import { type SubscriptionTier, type SubscriptionPeriod } from '@prisma/client';

// ─────────────────────────────────────────
//  PLAN CODES — REFERENCED, NOT CREATED AT RUNTIME
//
//  DECISION: the four Paystack Plans (Celebrate/Elevate x Monthly/
//  Annual) are created ONCE per Paystack environment (test, and later
//  live) via prisma/create-subscription-plans.ts, run manually, and
//  their resulting plan codes are set here via environment variables —
//  never created on first use by the running application.
//
//  Argued: Paystack's Create Plan endpoint has no idempotency key and
//  no "find or create by name" semantics — calling it twice with the
//  same name produces two DIFFERENT plans with different codes. If
//  plan creation happened lazily on first use, a redeploy racing with
//  itself (two instances starting cold at once, or a retried request)
//  could silently mint a second "Celebrate Monthly" plan, and from then
//  on which tenant is on which of the two would depend on request
//  timing — exactly the "plan codes drifting between environments"
//  failure mode the task warns about, except drifting WITHIN one
//  environment. Referencing fixed, explicitly-set codes makes exactly
//  which Paystack object backs each tier+period a one-line, auditable
//  fact per environment (dev test-mode plans and prod live-mode plans
//  are entirely separate Paystack objects regardless, so there is no
//  world where they could be shared even if runtime creation were
//  safe). This is the same pattern already established for
//  PAYSTACK_SECRET_KEY/PLATFORM_COMMISSION_PERCENT — payment
//  configuration lives in environment variables, not in code that
//  regenerates it.
// ─────────────────────────────────────────

// ZAR, integer cents — the prices stated in the task prompt, fixed
// (unlike ticket commission, these are not derived from anything and
// need no gross-up: EventGenie IS the seller here).
export const SUBSCRIPTION_PRICES_CENTS: Record<SubscriptionTier, Record<SubscriptionPeriod, number>> = {
  SPARK: { MONTHLY: 0, ANNUAL: 0 },
  CELEBRATE: { MONTHLY: 29_900, ANNUAL: 299_000 },
  ELEVATE: { MONTHLY: 99_900, ANNUAL: 999_000 },
};

const PLAN_ENV_VAR: Record<'CELEBRATE' | 'ELEVATE', Record<SubscriptionPeriod, string>> = {
  CELEBRATE: { MONTHLY: 'PAYSTACK_PLAN_CELEBRATE_MONTHLY', ANNUAL: 'PAYSTACK_PLAN_CELEBRATE_ANNUAL' },
  ELEVATE: { MONTHLY: 'PAYSTACK_PLAN_ELEVATE_MONTHLY', ANNUAL: 'PAYSTACK_PLAN_ELEVATE_ANNUAL' },
};

export type PaidSubscriptionTier = 'CELEBRATE' | 'ELEVATE';

export const isPaidTier = (tier: SubscriptionTier): tier is PaidSubscriptionTier =>
  tier === 'CELEBRATE' || tier === 'ELEVATE';

// Throws (a plain Error, matching payments.config.ts's own convention
// for a misconfigured environment) rather than returning undefined —
// silently subscribing a tenant to no plan is worse than refusing.
export const getPlanCode = (tier: PaidSubscriptionTier, period: SubscriptionPeriod): string => {
  const envVar = PLAN_ENV_VAR[tier][period];
  const code = process.env[envVar];
  if (!code) {
    throw new Error(
      `${envVar} is not defined in .env — run prisma/create-subscription-plans.ts to create the Paystack plans for this environment, then set the resulting codes.`
    );
  }
  return code;
};

// The reverse lookup — given a plan code a webhook told us about,
// which tier+period does it represent. Needed because a renewal
// charge.success carries the PLAN, not anything we chose ourselves
// (see payment-webhook.service.ts's subscription dispatch).
export const resolveTierAndPeriodFromPlanCode = (
  planCode: string
): { tier: PaidSubscriptionTier; period: SubscriptionPeriod } | null => {
  for (const tier of ['CELEBRATE', 'ELEVATE'] as const) {
    for (const period of ['MONTHLY', 'ANNUAL'] as const) {
      if (process.env[PLAN_ENV_VAR[tier][period]] === planCode) {
        return { tier, period };
      }
    }
  }
  return null;
};
