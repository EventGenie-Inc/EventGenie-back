import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

// ─────────────────────────────────────────
//  TIER REFUSAL WORDING
//
//  With `payments` off (the free launch pilot) nobody can pay, so a tier
//  refusal must not point anyone at a plan, an upgrade, a pass or a price.
//  Every organiser-facing tier refusal picks its message here: the plan
//  wording while payments are on, the launch wording while they're off.
//  Only the message changes; each call site keeps its own status and code.
//  Guest-facing refusals already carry no plan language (STEERING
//  "Guest-facing responses") and don't come through here.
// ─────────────────────────────────────────

export const LAUNCH_CONTACT_EMAIL = 'admin@e-velope.co.za';

const CONTACT_FOR_MORE = `Contact us at ${LAUNCH_CONTACT_EMAIL} if you need more.`;
const CONTACT_FOR_ACCESS = `Contact us at ${LAUNCH_CONTACT_EMAIL} if you need it.`;

// A limit was reached: "<what>. Contact us … if you need more."
export const launchLimitMessage = (what: string): string =>
  `${what} during our launch period. ${CONTACT_FOR_MORE}`;

// A feature isn't available on this account: "<feature> isn't available …"
export const launchUnavailableMessage = (feature: string): string =>
  `${feature} isn't available on your account during our launch period. ${CONTACT_FOR_ACCESS}`;

export const tierRefusalMessage = (planMessage: string, launchMessage: string): string =>
  isFeatureEnabled('payments') ? planMessage : launchMessage;
