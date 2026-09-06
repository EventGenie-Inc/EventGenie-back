import { type EventVisibility, type EventTicketing, type SubscriptionTier } from '@prisma/client';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';

export interface EventTierCheckInput {
  visibility?: EventVisibility;
  ticketing?: EventTicketing;
  hasCustomRsvpFields?: boolean;
}

// SPARK-only capability gates. These are not modeled as columns on
// SubscriptionTierConfig — they're binary restrictions tied to the free
// tier by name, not a numeric limit a Super Admin would tune per tier.
const assertSparkCapabilityGates = (tier: SubscriptionTier, input: EventTierCheckInput): void => {
  if (tier !== 'SPARK') return;

  if (input.visibility === 'PUBLIC') {
    throw new HttpError(403, 'The SPARK plan only supports private events. Upgrade to CELEBRATE or ELEVATE to make this event public.');
  }
  if (input.ticketing === 'PAID') {
    throw new HttpError(403, 'The SPARK plan does not support paid ticketing. Upgrade to CELEBRATE or ELEVATE to sell tickets.');
  }
  if (input.hasCustomRsvpFields) {
    throw new HttpError(403, 'The SPARK plan does not support custom RSVP fields. Upgrade to CELEBRATE or ELEVATE to add them.');
  }
};

// Called before creating a new event (POST /api/events and event-draft materialize).
export const assertEventCreatable = async (tenantId: string, input: EventTierCheckInput): Promise<void> => {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  assertSparkCapabilityGates(tenant.subscriptionTier, input);

  // maxEvents is read from SubscriptionTierConfig for every tier (including
  // SPARK) rather than hardcoded, so a Super Admin changing the config
  // takes effect immediately without a code change.
  const config = await subscriptionTierConfigRepository.findByTier(tenant.subscriptionTier);
  if (config?.maxEvents != null) {
    const activeCount = await eventRepository.countActive(tenantId);
    if (activeCount >= config.maxEvents) {
      throw new HttpError(
        403,
        `The ${tenant.subscriptionTier} plan allows a maximum of ${config.maxEvents} active event(s). Archive an existing event or upgrade your plan to create another.`
      );
    }
  }
};

// Called before updating an existing event (PUT /api/events/:id). No
// maxEvents check here — an update doesn't create a new event.
export const assertEventUpdatable = async (tenantId: string, input: EventTierCheckInput): Promise<void> => {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  assertSparkCapabilityGates(tenant.subscriptionTier, input);
};
