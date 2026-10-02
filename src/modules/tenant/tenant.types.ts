import { type SubscriptionTier, type SubscriptionStatus } from '@prisma/client';

// Deliberate, hand-picked projection — every tenant.router.ts response
// (me/list/detail/suspend/reactivate) returns exactly this, never the
// raw Prisma row. Tenant carries live Paystack charging credentials
// (paystackAuthorizationCode, paystackSubscriptionEmailToken) alongside
// its own subaccount/subscription bookkeeping — none of it has any
// business reaching a browser, and nothing in eventgenie-front's
// Tenant model (core/models/tenant.model.ts) reads anything beyond
// what's listed here. Built as an explicit allowlist (not a spread of
// the Prisma row) so this can never silently start leaking a field
// added to Tenant later — same reasoning as event-public.service.ts's
// toPublicView and rsvp.service.ts's validate().
export interface ClientTenantDto {
  id: string;
  name: string;
  slug: string;
  email: string;
  subscriptionTier: SubscriptionTier;
  subscriptionStatus: SubscriptionStatus;
  createdAt: Date;
}

// Vendor Space limit info — added to the allowlist deliberately (see
// tenant.service.ts's getDetail). limit is the same number
// assertVendorSpaceCreatable enforces, via resolveVendorSpaceLimit;
// null means unlimited, distinct from the field being absent (a
// consumer that only checks `!vendorSpaceLimit.limit` cannot tell
// unlimited from zero, so it must check `=== null` explicitly — see
// eventgenie-front's Tenant model for the corresponding field, which
// must do the same).
export interface VendorSpaceLimitDto {
  limit: number | null; // null = unlimited
  currentCount: number; // active (non-archived) vendor spaces this tenant owns right now
}

// Returned only by tenant.service.ts's getDetail (GET /api/tenants/me and
// SUPER_ADMIN's GET /api/tenants/:id) — never by getAll or getById, which
// stay at plain ClientTenantDto so a tenant list or an internal
// ownership-gate check doesn't pay for the extra vendor-space queries.
export interface ClientTenantDetailDto extends ClientTenantDto {
  vendorSpaceLimit: VendorSpaceLimitDto;
}
