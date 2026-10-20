import { type EventVisibility, type EventTicketing, type SubscriptionTier } from '@prisma/client';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEffectiveTier } from '../subscription/effective-tier.util.js';
import { resolveEventEntitlement, type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { resolveTierCapability } from './tier-capabilities.util.js';
import { launchLimitMessage, launchUnavailableMessage, tierRefusalMessage } from './tier-refusal-wording.util.js';

export interface EventTierCheckInput {
  visibility?: EventVisibility;
  ticketing?: EventTicketing;
  hasCustomRsvpFields?: boolean;
}

// Capability gates. These used to be tied to SPARK by name; they are now
// per-tier settings on SubscriptionTierConfig (tier-capabilities.util.ts),
// so a Super Admin can switch any of them on for any tier. The config is
// read only when the input actually asks for one of them.
const assertCapabilityGates = async (tier: SubscriptionTier, input: EventTierCheckInput): Promise<void> => {
  if (input.visibility !== 'PUBLIC' && input.ticketing !== 'PAID' && !input.hasCustomRsvpFields) return;
  const config = await subscriptionTierConfigRepository.findByTier(tier);

  if (input.visibility === 'PUBLIC' && !resolveTierCapability(config, tier, 'publicEventsEnabled')) {
    throw new HttpError(403, tierRefusalMessage(
      `The ${tier} plan only supports private events. Upgrade your plan to make this event public.`,
      launchUnavailableMessage('Public events', { plural: true })
    ));
  }
  if (input.ticketing === 'PAID' && !resolveTierCapability(config, tier, 'paidTicketingEnabled')) {
    throw new HttpError(403, paidTicketingRefusal(tier));
  }
  if (input.hasCustomRsvpFields && !resolveTierCapability(config, tier, 'customRsvpFieldsEnabled')) {
    throw new HttpError(403, tierRefusalMessage(
      `The ${tier} plan does not support additional fields. Upgrade your plan to add them.`,
      launchUnavailableMessage('Additional fields', { plural: true })
    ));
  }
};

// Shared with payment-account-readiness.util.ts, which refuses the same
// capability on the bank-details side.
export const paidTicketingRefusal = (tier: SubscriptionTier, passHint = false): string =>
  tierRefusalMessage(
    `The ${tier} plan does not support paid ticketing. Upgrade your plan${passHint ? ', or buy an Event Pass for this event,' : ''} to sell tickets.`,
    launchUnavailableMessage('Paid ticketing')
  );

// Called before creating a new event (POST /api/events and event-draft
// materialize). CREATION-TIME: correctly bound by the tenant's CURRENT
// effective tier (Subscription Billing batch) — a lapsed tenant cannot
// start a sixth event or a new PUBLIC/PAID one, exactly as a tenant who
// never upgraded couldn't. This never touches an event that already
// exists, so it cannot break one.
export const assertEventCreatable = async (tenantId: string, input: EventTierCheckInput): Promise<void> => {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  const effectiveTier = resolveEffectiveTier(tenant);
  await assertCapabilityGates(effectiveTier, input);

  // maxEvents is read from SubscriptionTierConfig for every tier (including
  // SPARK) rather than hardcoded, so a Super Admin changing the config
  // takes effect immediately without a code change.
  const config = await subscriptionTierConfigRepository.findByTier(effectiveTier);
  if (config?.maxEvents != null) {
    const activeCount = await eventRepository.countActive(tenantId);
    if (activeCount >= config.maxEvents) {
      throw new HttpError(
        403,
        tierRefusalMessage(
          `The ${effectiveTier} plan allows a maximum of ${config.maxEvents} active event(s). Archive an existing event or upgrade your plan to create another.`,
          launchLimitMessage(`You've reached the limit of ${config.maxEvents} active event(s)`, 'Archive an event you no longer need')
        )
      );
    }
  }
};

// Called before updating an existing event (PUT /api/events/:id). No
// maxEvents check here — an update doesn't create a new event.
//
// EVENT-SCOPED (Event Pass batch) — unlike assertEventCreatable, this
// runs on an event that already EXISTS and may already hold an active
// pass, so it resolves entitlement via resolveEventEntitlement (the
// greater of the tenant's own effective tier and the event's pass)
// rather than resolveEffectiveTier alone. Takes the full fetched event
// (not a bare tenantId) so a missed call site fails to compile rather
// than silently falling back to tenant-only resolution.
//
// Still CREATION-adjacent, not access-time, and safe on effective
// entitlement: assertCapabilityGates only fires when
// visibility/ticketing is EXPLICITLY part of THIS update payload (see
// the conditional spreads at every call site — event.service.ts never
// includes a field the caller didn't send), so editing an unrelated
// field (name, description) on an event that is already PUBLIC/PAID
// never re-evaluates this gate at all. Only a genuine attempt to newly
// flip visibility to PUBLIC or ticketing to PAID is blocked for a
// lapsed-and-unpassed tenant — the event's EXISTING public/paid status,
// and everything guest-facing built on it (RSVPs, ticket purchases), is
// untouched by this function, which never runs on any guest-facing path.
//
// Flagged, not fixed (pre-existing, independent of this batch): a
// well-behaved frontend that always resends the event's CURRENT
// ticketing/visibility on every edit (rather than omitting unchanged
// fields) would re-trigger this gate on every save once a tenant lapses
// — even though nothing is actually changing. Fixing that needs this
// function to compare against the event's stored value, which is a
// larger signature change out of scope for subscription billing.
export const assertEventUpdatable = async (event: EntitlementDerivableEvent, input: EventTierCheckInput): Promise<void> => {
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  await assertCapabilityGates(resolveEventEntitlement(tenant, event), input);
};
