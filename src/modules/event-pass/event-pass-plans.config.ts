import { type EventPassTier } from '@prisma/client';
import { type PaidSubscriptionTier } from '../subscription/subscription-plans.config.js';

// ─────────────────────────────────────────
//  EVENT PASS — PRICING & TIER MAPPING
//
//  Fixed prices, ZAR integer cents (same convention as
//  subscription-plans.config.ts's SUBSCRIPTION_PRICES_CENTS) — not
//  derived from anything, no gross-up (this is EventGenie's own money,
//  like a subscription, not a split ticket sale).
// ─────────────────────────────────────────
export const EVENT_PASS_PRICES_CENTS: Record<EventPassTier, number> = {
  SMALL: 39_900,
  STANDARD: 79_900,
  LARGE: 129_900,
};

// Ordering for upgrade comparisons (event-pass.service.ts's purchasePass)
// — an "upgrade" must target a strictly higher pass tier than whatever
// is currently active on the event.
export const EVENT_PASS_TIER_RANK: Record<EventPassTier, number> = {
  SMALL: 0,
  STANDARD: 1,
  LARGE: 2,
};

// ─────────────────────────────────────────
//  TIER MAPPING — governs FEATURES only (Memory Hub, vendor discovery,
//  custom RSVP fields, paid ticketing, PUBLIC visibility). Guest caps
//  are NOT read from this mapping — see EVENT_PASS_GUEST_CAP below.
//
//  "A Standard pass makes that event behave exactly as if the tenant
//  were on Celebrate" is explicit in the batch prompt. That pins
//  STANDARD -> CELEBRATE. The other two aren't pinned as directly, so:
//
//  SPARK is disqualified for EVERY pass tier, including Small — SPARK
//  blocks Memory Hub, vendor discovery, custom RSVP fields and PUBLIC
//  visibility outright (event-tier-enforcement.util.ts's
//  assertSparkCapabilityGates), and the prompt is explicit that
//  "Everything [is] included at every level" of the pass. So only
//  CELEBRATE and ELEVATE are eligible targets for all three pass tiers.
//
//  Given only two eligible tiers for three price points: SMALL and
//  STANDARD both map to CELEBRATE. LARGE maps to ELEVATE rather than
//  also landing on CELEBRATE, so the roomiest tier isn't stuck at
//  Celebrate's own feature ceiling.
//
//  SMALL and STANDARD are therefore FEATURE-identical — they unlock the
//  same things. They are NOT guest-limit-identical: that used to follow
//  from this same table (both resolving to Celebrate's 300-guest cap),
//  which made paying for Standard pointless. It no longer does — see
//  EVENT_PASS_GUEST_CAP, which gives each pass tier its own advertised
//  guest number, independent of this feature mapping.
// ─────────────────────────────────────────
export const EVENT_PASS_GRANTED_TIER: Record<EventPassTier, PaidSubscriptionTier> = {
  SMALL: 'CELEBRATE',
  STANDARD: 'CELEBRATE',
  LARGE: 'ELEVATE',
};

// ─────────────────────────────────────────
//  GUEST CAP — the pass's OWN advertised guest ceiling, independent of
//  EVENT_PASS_GRANTED_TIER above. "Up to 50/150/300 guests" is what is
//  sold at each price point; the tier table above is an implementation
//  detail for features only and must not be reused to derive this
//  number (that was the bug: Small and Standard both mapping to
//  Celebrate's 300-guest ceiling made the middle tier worthless).
//
//  Consumed ONLY by assertGuestsCreatable
//  (guest-tier-enforcement.util.ts), taking the greater of this and the
//  tenant's own effective-tier guest limit — never a bare replacement,
//  same reasoning as resolveEventEntitlement's max-of-two for features.
// ─────────────────────────────────────────
export const EVENT_PASS_GUEST_CAP: Record<EventPassTier, number> = {
  SMALL: 50,
  STANDARD: 150,
  LARGE: 300,
};

// Per-invite SMS cost the batch prompt names directly ("roughly R2.22
// per invite") — the only genuine marginal cost in this feature, priced
// linearly (organiser picks a quantity; no fixed pack sizes, since none
// were specified anywhere in the brief).
export const SMS_BUNDLE_UNIT_PRICE_CENTS = 222;
