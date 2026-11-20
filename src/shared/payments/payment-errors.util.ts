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

export const toPaymentHttpError = (failure: PaystackFailureDescription, configMessage: string): HttpError => {
  if (failure.kind === 'config') return new HttpError(500, configMessage);
  if (failure.kind === 'rejected') return new HttpError(422, PAYMENT_REJECTED_MESSAGE, PAYMENT_REJECTED);
  return new HttpError(503, PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
};
