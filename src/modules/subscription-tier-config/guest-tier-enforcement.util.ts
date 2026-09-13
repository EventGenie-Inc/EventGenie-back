import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { guestRepository } from '../guest/guest.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEffectiveTier } from '../subscription/effective-tier.util.js';

// Called before creating guest(s) on an event — both manual single-create
// (additionalCount=1) and bulk import (additionalCount=validRows.length)
// share this one check, so the maxGuestsPerEvent limit can't be bypassed
// by adding guests one at a time. Evaluated against the EVENT's owning
// tenant, not the requester's, mirroring assertEventUpdatable's existing
// reasoning: a SUPER_ADMIN acting on a SPARK tenant's event must still be
// bound by that tenant's plan, and has no tenantId of their own to fall
// back on.
export const assertGuestsCreatable = async (
  eventId: string,
  eventTenantId: string,
  additionalCount: number
): Promise<void> => {
  const tenant = await tenantRepository.findById(eventTenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  // Creation-time (a NEW guest — organiser add, bulk import, or a
  // brand-new public self-registrant): correctly bound by the tenant's
  // CURRENT effective tier, including a lapsed one. This does not
  // affect an already-invited guest submitting their own RSVP — that
  // path never calls this function at all (rsvp.service.ts's submit()
  // only updates an existing Invite/Guest, no capacity check), so "an
  // existing invitation still resolves" is unaffected regardless of
  // what this returns.
  const effectiveTier = resolveEffectiveTier(tenant);
  const config = await subscriptionTierConfigRepository.findByTier(effectiveTier);
  if (config?.maxGuestsPerEvent == null) return; // null = unlimited

  const existingCount = await guestRepository.countForEvent(eventId);
  const projected = existingCount + additionalCount;

  if (projected > config.maxGuestsPerEvent) {
    const over = projected - config.maxGuestsPerEvent;
    throw new HttpError(
      403,
      `The ${effectiveTier} plan allows a maximum of ${config.maxGuestsPerEvent} guest(s) per event. ` +
        `This event currently has ${existingCount} guest(s), and this would add ${additionalCount} more ` +
        `(${projected} total) — ${over} over the limit. Remove guests or upgrade the plan to continue.`
    );
  }
};
