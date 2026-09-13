import { type SubscriptionTier } from '@prisma/client';

// ─────────────────────────────────────────
//  EFFECTIVE TIER — the single derivation point
//
//  Tenant.subscriptionTier is the LAST tier a subscription actually
//  granted — it is NOT, on its own, what a tenant is currently entitled
//  to. Two things can make the true, current entitlement lower than the
//  stored value, and neither is swept by a job (this codebase has none
//  — see event-status.util.ts's COMPLETED derivation and the ticketing
//  batch's hold-expiry sweep for the same reasoning applied here):
//
//   1. subscriptionCancelAtPeriodEnd — the tenant cancelled or is
//      downgrading; the subscription is already disabled at Paystack,
//      but they paid for the current period and keep it until
//      subscriptionCurrentPeriodEnd.
//   2. subscriptionGraceStartedAt — a renewal charge failed; the tenant
//      keeps full access for a 5-day grace window from that moment,
//      per the task's explicit rule, before falling to SPARK.
//
//  EVERY tier check in this codebase MUST call this function rather
//  than read tenant.subscriptionTier directly — a missed one means a
//  lapsed tenant keeping a tier's features. See the batch report for
//  the full audit of every existing call site and how each was
//  updated (or deliberately left reading the raw stored value, for the
//  handful of cases — e.g. an in-flight ticket purchase on an already-
//  published event — where an ACCESS-TIME check must never re-evaluate
//  tier at all, at the risk of breaking something a guest is already
//  mid-way through).
//
//  Pure and synchronous — takes whatever the caller already fetched,
//  computes nothing itself from the database, and is exercised without
//  any Prisma call at all in tests.
// ─────────────────────────────────────────

const GRACE_PERIOD_DAYS = 5;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export interface TenantSubscriptionState {
  subscriptionTier: SubscriptionTier;
  subscriptionCancelAtPeriodEnd: boolean;
  subscriptionCurrentPeriodEnd: Date | null;
  subscriptionGraceStartedAt: Date | null;
}

export const resolveEffectiveTier = (tenant: TenantSubscriptionState, now: Date = new Date()): SubscriptionTier => {
  // Nothing to derive — SPARK has no lower fallback and no billing
  // state that could lapse.
  if (tenant.subscriptionTier === 'SPARK') return 'SPARK';

  // Cancellation / downgrade-to-a-different-paid-tier: access continues
  // only through the period already paid for. subscriptionPendingTierAfterPeriodEnd
  // is deliberately NOT read here — it is informational display only
  // (see its own schema comment), never auto-applied, since nothing in
  // this codebase can safely create a new paid subscription at a future
  // boundary with no scheduler and no Paystack-side proration support.
  if (tenant.subscriptionCancelAtPeriodEnd) {
    if (tenant.subscriptionCurrentPeriodEnd && now < tenant.subscriptionCurrentPeriodEnd) {
      return tenant.subscriptionTier;
    }
    return 'SPARK';
  }

  // Failed-renewal grace — five full days of unchanged access from the
  // moment the failure was recorded, then SPARK.
  if (tenant.subscriptionGraceStartedAt) {
    const graceDeadline = tenant.subscriptionGraceStartedAt.getTime() + GRACE_PERIOD_MS;
    if (now.getTime() < graceDeadline) return tenant.subscriptionTier;
    return 'SPARK';
  }

  return tenant.subscriptionTier;
};

// Convenience predicate for the one access-time exception this batch
// found (Memory Hub guest uploads — see memory-hub-tier-enforcement.util.ts):
// still worth knowing whether a tenant has PAID for the current period
// even though effective tier has fallen, e.g. to decide whether a
// generous fallback quota is reasonable.
export const isWithinGraceOrPaidPeriod = (tenant: TenantSubscriptionState, now: Date = new Date()): boolean =>
  resolveEffectiveTier(tenant, now) !== 'SPARK';

// Presenter — same shape as event-status.util.ts's withEffectiveStatus:
// swaps the stored field for its effective value before a Tenant object
// goes out to a client, never persisted. A client-facing tenant read
// (tenant.service.ts's getById/getAll — the /api/tenants/me a logged-in
// admin's own frontend calls to know its current plan) must NEVER show
// the raw stored tier, or a lapsed tenant's own UI would keep offering
// features it no longer has.
export const withEffectiveTier = <T extends TenantSubscriptionState>(tenant: T): T => ({
  ...tenant,
  subscriptionTier: resolveEffectiveTier(tenant),
});
