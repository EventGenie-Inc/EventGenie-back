import {} from '@prisma/client';
// ─────────────────────────────────────────
//  PRIORITY PLACEMENT — derived, never stored.
//
//  Priority is purely a function of the owning tenant's CURRENT
//  subscription tier — there is no isPriority column on VendorSpace and
//  there must never be one. Same reasoning as Event's derived COMPLETED
//  status (event-status.util.ts): deriving means no drift when a tenant
//  upgrades or downgrades, and no backfill the day tier rules change.
//
//  This is the ONLY place the ELEVATE comparison is hardcoded — every
//  discovery query/response reads priority by calling this, never by
//  comparing the enum value a second time. Kept in its own leaf file
//  (no other imports) so both vendor.repository.ts and
//  vendor-tier-enforcement.util.ts can use it without an import cycle —
//  the latter already imports vendorRepository the other way.
// ─────────────────────────────────────────
export const isPriorityTier = (tier) => tier === 'ELEVATE';
//# sourceMappingURL=vendor-priority.util.js.map