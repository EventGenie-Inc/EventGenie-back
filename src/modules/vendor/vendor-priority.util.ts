import { type SubscriptionTier } from '@prisma/client';

// ─────────────────────────────────────────
//  PRIORITY PLACEMENT — derived, never stored.
//
//  Priority is purely a function of the owning tenant's CURRENT
//  subscription tier — there is no isPriority column on VendorSpace and
//  there must never be one. Same reasoning as Event's derived COMPLETED
//  status (event-status.util.ts): deriving means no drift when a tenant
//  upgrades or downgrades, and no backfill the day tier rules change.
//
//  Which tiers get it is a tier setting, vendorPriorityPlacement (Free
//  Pilot; it used to be ELEVATE by name). vendor.service.ts reads the set
//  of tiers that have it once per search (tiersWithCapability) and passes
//  it in; every discovery query/response reads priority by calling this.
//  Kept in its own leaf file so both vendor.repository.ts and
//  vendor-tier-enforcement.util.ts can use it without an import cycle —
//  the latter already imports vendorRepository the other way.
// ─────────────────────────────────────────
export const isPriorityTier = (
  tier: SubscriptionTier | null | undefined,
  priorityTiers: ReadonlySet<SubscriptionTier>
): boolean => !!tier && priorityTiers.has(tier);
