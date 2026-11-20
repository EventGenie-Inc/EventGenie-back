// ─────────────────────────────────────────
//  A CANCELLED CHECKOUT (STEERING "Payments", "A cancelled checkout")
//
//  Every subscription, Event Pass and SMS bundle checkout is started with
//  Paystack's cancel action (`metadata.cancel_action`): the URL the payer is
//  sent to when they press Cancel on Paystack's page. It is the product's own
//  callback page with `cancelled=true` and our `reference`, the parameter
//  Paystack itself adds on a normal return, so the page knows the payer has
//  come back and that they cancelled.
//
//  The redirect itself ends nothing (a browser can't be trusted, and the
//  payer may still pay that checkout in another tab). The page asks the
//  backend to check (POST /api/subscriptions/verify, or the pass's or
//  bundle's reconcile), which asks Paystack: a checkout Paystack calls
//  abandoned or failed ends there, so the next click starts a new one.
// ─────────────────────────────────────────

export const CHECKOUT_CANCELLED_PARAM = 'cancelled';

export const checkoutCancelUrl = (callbackUrl: string, reference: string): string => {
  const url = new URL(callbackUrl);
  url.searchParams.set(CHECKOUT_CANCELLED_PARAM, 'true');
  url.searchParams.set('reference', reference);
  return url.toString();
};
