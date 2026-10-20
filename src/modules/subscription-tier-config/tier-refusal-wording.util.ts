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

export const tierRefusalMessage = (planMessage: string, launchMessage: string): string =>
  isFeatureEnabled('payments') ? planMessage : launchMessage;
