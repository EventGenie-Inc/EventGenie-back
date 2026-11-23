import { HttpError } from '../errors/http-error.js';
import { type PaystackFailureDescription } from './paystack.client.js';

// ─────────────────────────────────────────
//  NEUTRAL PAYMENT ERRORS (payments release 1)
//
//  What a tenant admin reads when starting or changing a subscription, an
//  Event Pass or an SMS bundle fails. Paystack's own text (and a network
//  error's) stays in the server log and the ledger's payload only: it is
//  written for developers ("Invalid key", "Could not reach Paystack: fetch
//  failed") and must never reach a customer. Ticketing's guest wording is
//  not built on this yet (out of release 1's scope).
//
//   503 PAYMENT_PROVIDER_UNAVAILABLE — Paystack didn't answer, rate limited
//       us or failed on its side: try again shortly. Reported to Sentry
//       like every 5xx, which is what we want for a provider outage.
//   422 PAYMENT_REJECTED — Paystack refused the request.
//   500 (generic) — Paystack was never reached: our own configuration (a
//       missing plan code). No customer action fixes it.
// ─────────────────────────────────────────

export const PAYMENT_PROVIDER_UNAVAILABLE = 'PAYMENT_PROVIDER_UNAVAILABLE';
export const PAYMENT_REJECTED = 'PAYMENT_REJECTED';
export const PAYMENT_ALREADY_PENDING = 'PAYMENT_ALREADY_PENDING';
export const PAYMENT_IN_PROGRESS = 'PAYMENT_IN_PROGRESS';

export const PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE =
  "Payments aren't available for a moment. Nothing was charged. Please try again in a few minutes.";
export const PAYMENT_REJECTED_MESSAGE =
  "We couldn't start this payment. Nothing was charged. Please try again, or contact us at admin@e-velope.co.za if it keeps happening.";
export const PAYMENT_IN_PROGRESS_MESSAGE =
  'This payment is still being set up. Please wait a moment and try again.';

// A charge to the saved card (a plan change) refused because the card on
// the subscription couldn't be confirmed with Paystack at that moment
// (fix/payments-go-live): Paystack unreachable or unclear (503), or no
// reusable card on the subscription (422). Nothing was claimed or charged.
export const CARD_NOT_CONFIRMED = 'PAYMENT_CARD_NOT_CONFIRMED';
export const CARD_NOT_CONFIRMED_MESSAGE =
  "We couldn't confirm your card just now. Nothing was charged. Please try again in a few minutes.";

// The billing routes' own refusals, in a customer's words (never "tenant").
// The signed-in account's organisation is missing (404), or the account
// belongs to none (400: a super admin on an organisation's billing route).
export const ORGANISATION_NOT_FOUND_MESSAGE = "We couldn't find your organisation. Please sign in again.";
export const NO_ORGANISATION_MESSAGE = "Your account isn't part of an organisation, so it has no billing.";

// ─────────────────────────────────────────
//  409 PAYMENT_ALREADY_PENDING carries the purchase it is about (follow-ups
//  to payments release 1), as `details.pending`, so the page can say what
//  was started, offer its checkout link, and say when another choice can be
//  made, without reading the message:
//    product            EVENT_PASS | SMS_BUNDLE | SUBSCRIPTION
//    purchaseId         the pass or bundle purchase (null for a subscription)
//    passTier           EVENT_PASS only, else null
//    smsCount           SMS_BUNDLE only, else null
//    plan               SUBSCRIPTION only: { tier, period }, else null
//    isPlanChange       SUBSCRIPTION only: a plan change charged to the saved
//                       card (no checkout link), else false
//    amountCents        what it costs
//    startedAt          when it was started
//    canStartAnotherAt  when a different choice is allowed (startedAt + the
//                       reuse window, pending-checkout.util.ts)
//    authorizationUrl   its Paystack checkout, to finish paying (null while
//                       it is still being set up, and for a plan change)
// ─────────────────────────────────────────
export interface PendingPurchaseDetails {
  product: 'EVENT_PASS' | 'SMS_BUNDLE' | 'SUBSCRIPTION';
  purchaseId: string | null;
  passTier: string | null;
  smsCount: number | null;
  plan: { tier: string; period: string } | null;
  isPlanChange: boolean;
  amountCents: number | null;
  startedAt: Date | null;
  canStartAnotherAt: Date | null;
  authorizationUrl: string | null;
}

export const alreadyPendingError = (message: string, pending: PendingPurchaseDetails): HttpError =>
  new HttpError(409, message, PAYMENT_ALREADY_PENDING, { pending });

export const toPaymentHttpError =(failure: PaystackFailureDescription, configMessage: string): HttpError => {
  if (failure.kind === 'config') return new HttpError(500, configMessage);
  if (failure.kind === 'rejected') return new HttpError(422, PAYMENT_REJECTED_MESSAGE, PAYMENT_REJECTED);
  return new HttpError(503, PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
};
