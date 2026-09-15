import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository } from './subscription-tier-config.repository.js';
import { guestRepository } from '../guest/guest.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { resolveEffectiveTier } from '../subscription/effective-tier.util.js';
import { isEventPassActive, type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { EVENT_PASS_GUEST_CAP } from '../event-pass/event-pass-plans.config.js';

// Called before creating guest(s) on an event — both manual single-create
// (additionalCount=1) and bulk import (additionalCount=validRows.length)
// share this one check, so the maxGuestsPerEvent limit can't be bypassed
// by adding guests one at a time.
//
// EVENT-SCOPED (Event Pass batch) — "guest limits are already per
// event," per the batch prompt's own classification. Takes the full
// fetched event (id + tenantId + pass/day fields), not bare id/tenantId
// strings, so a missed call site fails to compile rather than falling
// back to tenant-only resolution. Evaluated against the EVENT's owning
// tenant, not the requester's, mirroring assertEventUpdatable's existing
// reasoning: a SUPER_ADMIN acting on a SPARK tenant's event must still be
// bound by that tenant's plan (or its event's pass), and has no tenantId
// of their own to fall back on.
export const assertGuestsCreatable = async (
  event: EntitlementDerivableEvent & { id: string },
  additionalCount: number
): Promise<void> => {
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  // Creation-time (a NEW guest — organiser add, bulk import, or a
  // brand-new public self-registrant): correctly bound by the event's
  // CURRENT entitlement, including a lapsed-and-unpassed tenant. This
  // does not affect an already-invited guest submitting their own RSVP —
  // that path never calls this function at all (rsvp.service.ts's
  // submit() only updates an existing Invite/Guest, no capacity check),
  // so "an existing invitation still resolves" is unaffected regardless
  // of what this returns.
  //
  // Deliberately NOT resolveEventEntitlement here. That resolves the
  // pass's GRANTED TIER — the feature mapping where Small and Standard
  // both land on Celebrate — and reusing it for the guest count would
  // keep the exact bug this exists to fix (Standard buying nothing over
  // Small). Instead, the pass's own advertised guest number
  // (EVENT_PASS_GUEST_CAP) stands on its own, alongside the tenant's
  // plain effective-tier limit — the greater of the two wins, never a
  // replacement, same shape as resolveEventEntitlement's max-of-two for
  // features so the two rules stay in spirit even though this one reads
  // its own dedicated number instead of a shared tier table.
  const tenantTier = resolveEffectiveTier(tenant);
  const tenantConfig = await subscriptionTierConfigRepository.findByTier(tenantTier);
  const tenantLimit = tenantConfig?.maxGuestsPerEvent ?? null; // null = unlimited

  // Unlimited on the tenant side alone already beats any pass cap — an
  // Elevate tenant buying a Small pass for one event must not find that
  // event suddenly capped at 50. Nothing below can turn a null back into
  // a number, so this is the one and only unlimited exit.
  if (tenantLimit === null) return;

  const passActive = isEventPassActive(event);
  const passCap = passActive ? EVENT_PASS_GUEST_CAP[event.eventPass!.passTier] : null;
  const effectiveLimit = passCap === null ? tenantLimit : Math.max(tenantLimit, passCap);

  const existingCount = await guestRepository.countForEvent(event.id);
  const projected = existingCount + additionalCount;

  if (projected > effectiveLimit) {
    const over = projected - effectiveLimit;
    // Attribute the message to whichever side is actually binding, so
    // "upgrade" points at the thing that would actually raise the cap.
    const boundByPass = passCap !== null && passCap >= tenantLimit;
    const source = boundByPass
      ? `This event's ${event.eventPass!.passTier} pass allows a maximum of ${effectiveLimit} guest(s) per event.`
      : `The ${tenantTier} plan allows a maximum of ${effectiveLimit} guest(s) per event.`;
    const upgradeHint = boundByPass ? 'upgrade the pass' : 'upgrade the plan';

    throw new HttpError(
      403,
      `${source} This event currently has ${existingCount} guest(s), and this would add ${additionalCount} more ` +
        `(${projected} total) — ${over} over the limit. Remove guests or ${upgradeHint} to continue.`
    );
  }
};
