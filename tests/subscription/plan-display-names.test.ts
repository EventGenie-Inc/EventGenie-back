import { describe, it, expect, afterEach, vi } from 'vitest';
import { tierRefusalMessage, planDisplayName } from '../../src/modules/subscription-tier-config/tier-refusal-wording.util.js';
import { paidTicketingRefusal } from '../../src/modules/subscription-tier-config/event-tier-enforcement.util.js';

// ─────────────────────────────────────────
//  PLAN REFUSALS IN CUSTOMERS' WORDS (ticket sales follow-ups)
//
//  Every tier refusal passes through tierRefusalMessage, which puts a tier
//  or pass code ("SPARK", "CELEBRATE or ELEVATE", "SMALL pass") into its
//  display name. A custom tier's name passes through as it is.
// ─────────────────────────────────────────

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('plan names in refusals', () => {
  it("every caller's shape reads in display names", () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const cases: [string, string][] = [
      ['The SPARK plan does not include Memory Hub. Upgrade to CELEBRATE or ELEVATE to use it.', 'The Spark plan does not include Memory Hub. Upgrade to Celebrate or Elevate to use it.'],
      ["This event's SMALL pass allows 50 guest(s), and this would bring the event to 51. Remove guests or upgrade the pass.", "This event's Small pass allows 50 guest(s), and this would bring the event to 51. Remove guests or upgrade the pass."],
      ["The ELEVATE plan doesn't include SMS, and 2 guest(s) in this batch only have a phone number.", "The Elevate plan doesn't include SMS, and 2 guest(s) in this batch only have a phone number."],
      ['The CELEBRATE plan allows a maximum of 3 active event(s).', 'The Celebrate plan allows a maximum of 3 active event(s).'],
    ];
    for (const [planMessage, expected] of cases) expect(tierRefusalMessage(planMessage, 'launch')).toBe(expected);
    expect(paidTicketingRefusal({ name: 'SPARK', customTier: null }, true)).toBe(
      'The Spark plan does not support paid ticketing. Upgrade your plan, or buy an Event Pass for this event, to sell tickets.'
    );
  });

  it("a custom tier's refusal uses its own name, even one in capitals", () => {
    expect(paidTicketingRefusal({ name: 'VIP Partners', customTier: { id: 'ct_1', name: 'VIP Partners', description: null, endsAt: null } })).toBe(
      "Paid ticketing isn't available on your VIP Partners plan. Contact us at admin@e-velope.co.za if you need it."
    );
    expect(planDisplayName('Free trial')).toBe('Free trial');
  });

  it('with payments off the free-trial wording is unchanged', () => {
    vi.stubEnv('FEATURES_DISABLED', 'payments');
    expect(tierRefusalMessage('The SPARK plan …', "Paid ticketing isn't available during your free trial.")).toBe(
      "Paid ticketing isn't available during your free trial."
    );
  });
});
