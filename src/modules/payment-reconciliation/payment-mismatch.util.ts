import { type Prisma } from '@prisma/client';
import { centsToDecimalString } from '../../shared/payments/money.util.js';
import { type AmountCheck } from '../../shared/payments/paystack-payload.util.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import { type WebhookContext } from '../payment-webhook/payment-webhook.types.js';
import { paymentReconciliationRepository } from './payment-reconciliation.repository.js';

export const formatRand = (cents: number | null | undefined, currency = 'ZAR'): string =>
  cents === null || cents === undefined ? 'unknown' : `${currency === 'ZAR' ? 'R' : `${currency} `}${centsToDecimalString(cents)}`;

export type PaymentProduct = 'SUBSCRIPTION' | 'EVENT_PASS' | 'SMS_BUNDLE' | 'TICKET';

export const PRODUCT_LABEL: Record<PaymentProduct, string> = {
  SUBSCRIPTION: 'subscription',
  EVENT_PASS: 'Event Pass',
  SMS_BUNDLE: 'SMS bundle',
  TICKET: 'ticket',
};

// ─────────────────────────────────────────
//  A SUCCESS FOR THE WRONG AMOUNT (payments release 1)
//
//  Paystack reported a successful payment whose amount or currency is not
//  what this purchase asked for. Nothing is granted. Recorded three ways: a
//  PAYMENT_AMOUNT_MISMATCH ledger row (with Paystack's payload), a
//  PaymentMismatch row for the super admin's list, and an alert email after
//  commit. The caller marks its own purchase UNDER_REVIEW.
// ─────────────────────────────────────────
export const recordAmountMismatch = async (
  ctx: Pick<WebhookContext, 'tx' | 'payload' | 'after'>,
  input: {
    product: PaymentProduct;
    reference: string | null;
    transactionId: string | null;
    tenantId: string | null;
    eventId: string | null;
    relatedType: string;
    relatedId: string;
    check: Extract<AmountCheck, { ok: false }>;
  }
): Promise<void> => {
  const { check } = input;
  await paymentLedgerRepository.create(
    {
      type: 'PAYMENT_AMOUNT_MISMATCH',
      amountCents: check.actualCents ?? 0,
      currency: check.actualCurrency ?? check.expectedCurrency,
      tenantId: input.tenantId,
      eventId: input.eventId,
      paystackReference: input.reference,
      paystackTransactionId: input.transactionId,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      payload: {
        product: input.product,
        expectedCents: check.expectedCents,
        expectedCurrency: check.expectedCurrency,
        actualCents: check.actualCents,
        actualCurrency: check.actualCurrency,
        provider: ctx.payload,
      } as unknown as Prisma.InputJsonValue,
    },
    ctx.tx
  );
  await paymentReconciliationRepository.createMismatch(
    {
      source: 'WEBHOOK',
      kind: 'UNEXPECTED_AMOUNT',
      paystackReference: input.reference,
      paystackTransactionId: input.transactionId,
      tenantId: input.tenantId,
      eventId: input.eventId,
      expectedAmountCents: check.expectedCents,
      actualAmountCents: check.actualCents,
      currency: check.actualCurrency,
      details: { product: input.product, expectedCurrency: check.expectedCurrency, relatedType: input.relatedType, relatedId: input.relatedId },
    },
    ctx.tx
  );
  ctx.after(async () => {
    await paymentAlertService.send({
      kind: 'AMOUNT_MISMATCH',
      subject: `A ${PRODUCT_LABEL[input.product]} payment came in for the wrong amount`,
      lines: [
        'Paystack reported this payment as successful, but its amount or currency is not what was asked for, so nothing was granted.',
        "Check the payment in Paystack's dashboard, then refund it or grant it by hand.",
      ],
      facts: [
        `Reference: ${input.reference ?? 'none'}`,
        `Expected: ${formatRand(check.expectedCents, check.expectedCurrency)}`,
        `Received: ${formatRand(check.actualCents, check.actualCurrency ?? 'unknown')}`,
        `Tenant: ${input.tenantId ?? 'unknown'}`,
        ...(input.eventId ? [`Event: ${input.eventId}`] : []),
      ],
    });
  });
};

// ─────────────────────────────────────────
//  A SECOND PAYMENT FOR SOMETHING ALREADY PAID FOR (follow-ups to payments
//  release 1)
//
//  Typically an abandoned checkout paid after a newer one for the same thing
//  was paid. Nothing extra is granted. Recorded three ways, like a wrong
//  amount: a PAYMENT_DUPLICATE ledger row (with Paystack's payload and the
//  payment it duplicates), a DUPLICATE_PAYMENT PaymentMismatch row, and one
//  alert after commit asking for a refund. The caller marks its own
//  purchase UNDER_REVIEW (passes, bundles), which is what makes a
//  redelivery a no-op; a subscription's caller checks existsFor first.
// ─────────────────────────────────────────
export const recordDuplicatePayment = async (
  ctx: Pick<WebhookContext, 'tx' | 'payload' | 'after'>,
  input: {
    product: PaymentProduct;
    reference: string | null;
    transactionId: string | null;
    tenantId: string | null;
    eventId: string | null;
    relatedType: string;
    relatedId: string;
    amountCents: number;
    currency: string;
    occurredAt?: Date;
    // The earlier payment this one duplicates.
    duplicates: { reference: string | null; relatedId: string | null; description: string };
  }
): Promise<void> => {
  await paymentLedgerRepository.create(
    {
      type: 'PAYMENT_DUPLICATE',
      amountCents: input.amountCents,
      currency: input.currency,
      tenantId: input.tenantId,
      eventId: input.eventId,
      paystackReference: input.reference,
      paystackTransactionId: input.transactionId,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
      ...(input.occurredAt && { occurredAt: input.occurredAt }),
      payload: {
        product: input.product,
        duplicates: input.duplicates,
        provider: ctx.payload,
      } as unknown as Prisma.InputJsonValue,
    },
    ctx.tx
  );
  await paymentReconciliationRepository.createMismatch(
    {
      source: 'WEBHOOK',
      kind: 'DUPLICATE_PAYMENT',
      paystackReference: input.reference,
      paystackTransactionId: input.transactionId,
      tenantId: input.tenantId,
      eventId: input.eventId,
      actualAmountCents: input.amountCents,
      currency: input.currency,
      details: { product: input.product, relatedType: input.relatedType, relatedId: input.relatedId, duplicates: input.duplicates },
    },
    ctx.tx
  );
  ctx.after(async () => {
    await paymentAlertService.send({
      kind: 'DUPLICATE_PAYMENT',
      subject: `Duplicate payment: the ${PRODUCT_LABEL[input.product]} was paid for twice`,
      lines: [
        `This payment duplicates one already paid (${input.duplicates.description}), so nothing extra was granted.`,
        "Refund it from Paystack's dashboard (Transactions → the payment → Refund).",
      ],
      facts: [
        `Reference: ${input.reference ?? 'none'}`,
        `Duplicates: ${input.duplicates.reference ?? input.duplicates.relatedId ?? 'unknown'}`,
        `Amount: ${formatRand(input.amountCents, input.currency)}`,
        `Tenant: ${input.tenantId ?? 'unknown'}`,
        ...(input.eventId ? [`Event: ${input.eventId}`] : []),
      ],
    });
  });
};
