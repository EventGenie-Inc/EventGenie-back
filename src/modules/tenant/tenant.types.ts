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
