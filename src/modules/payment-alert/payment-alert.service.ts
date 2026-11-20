import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, sendEmail, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { LAUNCH_CONTACT_EMAIL } from '../subscription-tier-config/tier-refusal-wording.util.js';
import { type PaymentAlertInput, type PaymentAlertKind } from './payment-alert.types.js';

// ─────────────────────────────────────────
//  PAYMENT ALERTS (payments release 1)
//
//  An email to the people who run e-velope's money (PAYMENTS_ALERT_EMAIL,
//  default admin@e-velope.co.za) when something needs a person: a
//  chargeback, a payment for the wrong amount, a webhook nothing handles,
//  a reconciliation mismatch, a second live subscription, a refund that
//  failed or didn't match anything.
//
//  Sent AFTER the database work it describes has committed (callers queue it
//  as post-commit work), and never throws: an alert that can't be sent is
//  logged and leaves the payment's handling exactly as it was. The ledger
//  and PaymentMismatch rows are the record; the email is only the nudge.
//  It names ids, references and amounts, never a card number or a guest's
//  contact details.
// ─────────────────────────────────────────

const KIND_EYEBROW: Record<PaymentAlertKind, string> = {
  DISPUTE: 'Chargeback',
  AMOUNT_MISMATCH: 'Amount mismatch',
  UNHANDLED_WEBHOOK: 'Unhandled webhook',
  RECONCILIATION: 'Reconciliation',
  DUPLICATE_SUBSCRIPTION: 'Duplicate subscription',
  REFUND: 'Refund',
  SYNC: 'Subscription sync',
};

export const paymentAlertRecipient = (): string => process.env.PAYMENTS_ALERT_EMAIL?.trim() || LAUNCH_CONTACT_EMAIL;

export const buildPaymentAlertEmail = (input: PaymentAlertInput): OutgoingEmail => {
  const subject = `[e-velope payments] ${input.subject}`;
  const { html, text } = renderEmail({
    subject,
    preheader: input.lines[0] ?? input.subject,
    blocks: [
      { kind: 'eyebrow', text: KIND_EYEBROW[input.kind] },
      { kind: 'title', text: input.subject },
      ...input.lines.map((line) => ({ kind: 'paragraph' as const, text: line })),
      ...(input.facts && input.facts.length > 0
        ? [{ kind: 'details' as const, groups: [{ heading: null, lines: input.facts }] }]
        : []),
      { kind: 'button', label: 'Open payments', href: frontendUrl('/admin/payments') },
    ],
    reason: 'You received this because this address receives e-velope payment alerts.',
  });
  return {
    to: paymentAlertRecipient(),
    from: formatFromHeader('e-velope payments', eventSenderAddress()),
    subject,
    html,
    text,
  };
};

export const paymentAlertService = {
  send: async (input: PaymentAlertInput): Promise<boolean> => {
    try {
      const result = await sendEmail(buildPaymentAlertEmail(input));
      if (!result.ok) {
        console.error(`[payment alert] could not send "${input.subject}": ${result.reason}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[payment alert] could not send "${input.subject}":`, err);
      return false;
    }
  },
};
