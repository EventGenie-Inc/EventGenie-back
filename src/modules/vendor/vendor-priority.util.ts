import { type SubscriptionTier } from '@prisma/client';
import { type PlanIdentity } from '../subscription-tier-config/effective-plan.util.js';

// ─────────────────────────────────────────
//  PRIORITY PLACEMENT — derived, never stored.
//
//  Priority is purely a function of the owning tenant's CURRENT plan —
//  there is no isPriority column on VendorSpace and there must never be
//  one. Same reasoning as Event's derived COMPLETED status
//  (event-status.util.ts): deriving means no drift when a tenant upgrades
//  or downgrades, and no backfill the day tier rules change.
//
//  Which plans get it is a plan setting, vendorPriorityPlacement (Free
//  Pilot; it used to be ELEVATE by name): the standard tiers that have it
//  and, since custom tiers, the custom tiers that have it. vendor.service.ts
//  reads both once per search (plansWithCapability, effective-plan.util.ts)
//  and passes them in; every discovery query/response reads priority by
//  calling this with the owning tenant's plan identity (resolvePlanIdentity).
//  Kept in its own leaf file so both vendor.repository.ts and
//  vendor-tier-enforcement.util.ts can use it without an import cycle —
//  the latter already imports vendorRepository the other way.
// ─────────────────────────────────────────
export interface PriorityPlans {
  tiers: ReadonlySet<SubscriptionTier>;
  customTierIds: ReadonlySet<string>;
}

export const isPriorityPlan = (identity: PlanIdentity | null | undefined, plans: PriorityPlans): boolean => {
  if (!identity) return false;
  return identity.kind === 'CUSTOM' ? plans.customTierIds.has(identity.customTierId) : plans.tiers.has(identity.tier);
};
