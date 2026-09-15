import { type EventPassTier, type SubscriptionTier } from '@prisma/client';
import { resolveEffectiveTier, TIER_RANK, type TenantSubscriptionState } from '../subscription/effective-tier.util.js';
import { type EventDayLike, endOfDayUtc } from '../event/event-status.util.js';
import { EVENT_PASS_GRANTED_TIER } from './event-pass-plans.config.js';

// ─────────────────────────────────────────
//  EVENT ENTITLEMENT — the second resolution point, alongside (never
//  instead of) resolveEffectiveTier.
//
//  resolveEffectiveTier (subscription/effective-tier.util.ts) answers
//  "what is this TENANT entitled to right now" — grace periods,
//  cancel-at-period-end, etc. It is NOT edited by this batch.
//
//  resolveEventEntitlement answers the narrower, EVENT-scoped question:
//  "what is this ONE EVENT entitled to right now" — the greater of the
//  tenant's own effective tier and whatever an active Event Pass on
//  THIS event grants. It COMPOSES resolveEffectiveTier (calls it, once,
//  as the floor) rather than re-deriving tenant billing state itself —
//  two independent resolution paths would diverge, silently, exactly
//  the failure mode the batch prompt warns about.
//
//  Every EVENT-SCOPED tier check in this codebase must call THIS
//  function instead of resolveEffectiveTier directly, passing the
//  specific event a pass could apply to. A TENANT-SCOPED check (e.g.
//  assertVendorSpaceCreatable — a pass is for organising an event, not
//  listing yourself as a vendor) has no event to pass and keeps calling
//  resolveEffectiveTier exactly as before. See the batch report for the
//  full per-check classification.
// ─────────────────────────────────────────

const PASS_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, per the batch prompt

export interface EventPassLike {
  passTier: EventPassTier;
}

// The minimal shape every event-scoped tier check needs to resolve
// entitlement — deliberately NOT just `eventId`/`tenantId` strings. A
// bare tenantId string does not structurally satisfy this interface, so
// a call site that tries to fall back to tenant-only resolution (by
// passing just a string where this is required) fails to compile rather
// than silently under- or over-granting. See event.repository.ts's
// findById/findByShareToken and invite.repository.ts's findByToken,
// which include eventDays + eventPass on every Event object so this is
// satisfied "for free" at almost every call site.
export interface EntitlementDerivableEvent {
  tenantId: string;
  eventPass: EventPassLike | null;
  eventDays: EventDayLike[];
}

// DERIVED AT READ TIME from the event's own EventDays — no stored
// expiresAt, no scheduler (this codebase has none, by deliberate
// choice — same reasoning as event-status.util.ts's COMPLETED
// derivation, which this mirrors exactly, right down to "no days yet"
// meaning "nothing to measure from" rather than "already expired").
export const resolveEventPassExpiry = (eventDays: EventDayLike[]): Date | null => {
  if (!eventDays.length) return null;
  const lastDay = eventDays.reduce((latest, day) => (day.date > latest.date ? day : latest));
  const lastDayEnd = lastDay.endTime ?? endOfDayUtc(lastDay.date);
  return new Date(lastDayEnd.getTime() + PASS_GRACE_MS);
};

export const isEventPassActive = (event: EntitlementDerivableEvent, now: Date = new Date()): boolean => {
  if (!event.eventPass) return false;
  const expiry = resolveEventPassExpiry(event.eventDays);
  return expiry === null || now < expiry;
};

// "A PASS GRANTS A TIER EQUIVALENT, FOR ONE EVENT" — the greater of the
// tenant's own effective tier and the pass's granted tier, never a
// separate, independent grant. Expiry GRANDFATHERS, it does not break:
// once inactive, this simply falls back to whatever
// resolveEffectiveTier already says, exactly as if the pass had never
// existed — the event keeps working, just without the pass's boost.
export const resolveEventEntitlement = (
  tenant: TenantSubscriptionState,
  event: EntitlementDerivableEvent,
  now: Date = new Date()
): SubscriptionTier => {
  const tenantTier = resolveEffectiveTier(tenant, now);
  if (!isEventPassActive(event, now)) return tenantTier;

  const passTier = EVENT_PASS_GRANTED_TIER[event.eventPass!.passTier];
  return TIER_RANK[passTier] > TIER_RANK[tenantTier] ? passTier : tenantTier;
};
