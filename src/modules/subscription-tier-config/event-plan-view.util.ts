import { type EventPassTier, type SubscriptionTier } from '@prisma/client';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { customTierRepository } from '../custom-tier/custom-tier.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { isEventPassActive, type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { resolveEventPlan, resolvePlanIdentity } from './effective-plan.util.js';
import { planSettingsFromValues, type PlanSettings } from './plan-settings.util.js';
import { type GuestLimitInfo } from './guest-tier-enforcement.util.js';

// ─────────────────────────────────────────
//  THE EVENT'S PLAN — GET /api/events/:id's `plan` (STEERING "Custom tiers")
//
//  What applies to THIS event once the custom tier, Event Pass and grant
//  rules have run (resolveEventPlan, the resolution every event-scoped check
//  enforces), so the frontend never works it out itself: a granted event's
//  feature set, a pass's raise, a custom tier's own settings.
//
//  `settings` is /me's planSettings shape (planSettingsFromValues: a
//  switched-off feature's settings left out) for the event, with two numbers
//  set to what is actually enforced, where the plan's own value isn't it:
//  - maxGuestsPerEvent: the event's guest limit (resolveGuestLimit: an
//    Event Pass's own guest number stands beside the plan's), the same as
//    guestLimit.limit.
//  - maxSmsPerMonth: left out while the event has an active pass, whose SMS
//    come from the event's own bundle, never the monthly allowance (smsFrom
//    says which; the bundle's credits are on the pass's own routes).
//  maxEvents is left out: it is the tenant's, not an event's (on /me).
// ─────────────────────────────────────────

export interface EventPlanView {
  // The plan the settings come from, for display: the tenant's plan (a
  // standard tier's name or a custom tier's own), or, for a standard tier
  // raised by an Event Pass, the pass's tier. Never compared in code.
  name: string;
  // The tenant's own plan: its standard tier (null on a custom tier) and its
  // custom tier while current.
  tenantTier: SubscriptionTier | null;
  customTier: { id: string; name: string; description: string | null; endsAt: Date | null } | null;
  // A granted event's feature set (both null on any other event).
  grantedTier: SubscriptionTier | null;
  grantedCustomTier: { id: string; name: string } | null;
  passTier: EventPassTier | null;
  passActive: boolean;
  // Where this event's SMS come from (present while sms is on).
  smsFrom?: 'MONTHLY_ALLOWANCE' | 'EVENT_PASS_BUNDLE';
  settings: Omit<PlanSettings, 'maxEvents'>;
}

export const resolveEventPlanView = async (
  event: EntitlementDerivableEvent & { id: string },
  guestLimit: Pick<GuestLimitInfo, 'limit'>,
  now: Date = new Date()
): Promise<EventPlanView> => {
  const tenant = await tenantRepository.findById(event.tenantId, true);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  const plan = await resolveEventPlan(tenant, event, now);
  const identity = resolvePlanIdentity(tenant, now);
  const tenantPlanCustom = identity.kind === 'CUSTOM' ? plan.customTier : null;
  const passActive = isEventPassActive(event, now);
  const grantedCustom = event.grantedCustomTierId ? await customTierRepository.findById(event.grantedCustomTierId) : null;

  const { maxEvents: _maxEvents, ...settings } = planSettingsFromValues(plan.values);
  settings.maxGuestsPerEvent = guestLimit.limit;
  if (passActive) delete settings.maxSmsPerMonth;

  return {
    name: plan.name,
    tenantTier: identity.kind === 'STANDARD' ? identity.tier : null,
    customTier: tenantPlanCustom,
    grantedTier: event.grantedTier,
    grantedCustomTier: grantedCustom ? { id: grantedCustom.id, name: grantedCustom.name } : null,
    passTier: event.eventPass?.passTier ?? null,
    passActive,
    ...('smsEnabled' in settings && { smsFrom: passActive ? 'EVENT_PASS_BUNDLE' : 'MONTHLY_ALLOWANCE' }),
    settings,
  };
};
