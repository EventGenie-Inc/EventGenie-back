import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

// ─────────────────────────────────────────
//  TIER REFUSAL WORDING
//
//  With `payments` off (the free launch pilot) nobody can pay, so a tier
//  refusal must not point anyone at a plan, an upgrade, a pass or a price.
//  Every organiser-facing tier refusal picks its message here: the plan
//  wording while payments are on, the free-trial wording while they're off.
//  Only the message changes; each call site keeps its own status and code.
//  Guest-facing refusals already carry no plan language (STEERING
//  "Guest-facing responses") and don't come through here.
// ─────────────────────────────────────────

export const LAUNCH_CONTACT_EMAIL = 'admin@e-velope.co.za';

const CONTACT_FOR_MORE = `Contact us at ${LAUNCH_CONTACT_EMAIL} if you need more.`;

// A limit was reached: "<what> during your free trial. Contact us … if you
// need more." `instead` puts what the organiser can do themselves before
// the contact line, keeping the refusal to two sentences: "<what> during
// your free trial. <instead>, or contact us … if you need more."
export const launchLimitMessage = (what: string, instead?: string): string =>
  `${what} during your free trial. ` +
  (instead ? `${instead}, or contact us at ${LAUNCH_CONTACT_EMAIL} if you need more.` : CONTACT_FOR_MORE);

// A feature isn't available: "<feature> isn't available during your free
// trial. …". A plural name ("Public events") takes `plural`, so the verb and
// pronoun agree: "Public events aren't available … if you need them."
export const launchUnavailableMessage = (feature: string, { plural = false }: { plural?: boolean } = {}): string =>
  `${feature} ${plural ? "aren't" : "isn't"} available during your free trial. ` +
  `Contact us at ${LAUNCH_CONTACT_EMAIL} if you need ${plural ? 'them' : 'it'}.`;

// Custom tiers: a tenant on a custom tier (invoiced outside the app) is
// never pointed at a plan to buy either, payments on or off. It gets the
// launch wording with its own plan named instead of the free trial: "...
// isn't available on your Free trial plan. Contact us at ... if you need
// it." `plan` is the effective plan (effective-plan.util.ts); a caller with
// none (or a standard tier) gets the wording above, unchanged.
const FREE_TRIAL_PHRASES = [' during your free trial', ' during its free trial'] as const;

export const customPlanMessage = (launchMessage: string, planName: string): string =>
  launchMessage
    .replace(FREE_TRIAL_PHRASES[0], ` on your ${planName} plan`)
    .replace(FREE_TRIAL_PHRASES[1], ` on its ${planName} plan`);

// A plan's or a pass's name as customers read it: "Spark", not the code
// "SPARK" (STEERING "Payments": never a tier's code). A custom tier's name
// is its own and passes through as it is.
const DISPLAY_NAMES: Record<string, string> = {
  SPARK: 'Spark',
  CELEBRATE: 'Celebrate',
  ELEVATE: 'Elevate',
  SMALL: 'Small',
  STANDARD: 'Standard',
  LARGE: 'Large',
};

export const planDisplayName = (name: string): string => DISPLAY_NAMES[name] ?? name;

// Every tier or pass code in a message, in customers' words. The messages
// are built by each enforcement point from ResolvedPlan.name (the code, for
// a standard tier: other code compares it), so the one place they all pass
// through puts them right: "The SPARK plan … Upgrade to CELEBRATE or
// ELEVATE" reads "The Spark plan … Upgrade to Celebrate or Elevate".
const TIER_CODE = new RegExp(`\\b(${Object.keys(DISPLAY_NAMES).join('|')})\\b`, 'g');
export const withPlanDisplayNames = (message: string): string => message.replace(TIER_CODE, (code) => planDisplayName(code));

export const tierRefusalMessage = (
  planMessage: string,
  launchMessage: string,
  plan?: { customTier: { name: string } | null } | null
): string => {
  if (plan?.customTier) return customPlanMessage(launchMessage, plan.customTier.name);
  return isFeatureEnabled('payments') ? withPlanDisplayNames(planMessage) : launchMessage;
};
