import { type Prisma, type LedgerEntryType } from '@prisma/client';
import { type OriginalPaymentKeys } from '../../shared/payments/paystack-payload.util.js';
import { eventPassRepository } from '../event-pass/event-pass.repository.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { type OriginalPayment } from './payment-adjustment.types.js';
import { ticketOrderRepository } from '../ticket-order/ticket-order.repository.js';

const findNothingGrantedSubscriptionPayment = (keys: OriginalPaymentKeys, tx: Prisma.TransactionClient) => {
  const or: Prisma.PaymentLedgerEntryWhereInput[] = [];
  if (keys.reference) or.push({ paystackReference: keys.reference });
  if (keys.transactionId) or.push({ paystackTransactionId: keys.transactionId });
  if (or.length === 0) return Promise.resolve(null);
  return tx.paymentLedgerEntry.findFirst({
    where: { type: { in: ['PAYMENT_DUPLICATE', 'PAYMENT_AMOUNT_MISMATCH'] }, relatedType: 'Tenant', OR: or },
    orderBy: { createdAt: 'asc' },
  });
};

export const paymentAdjustmentRepository = {
  // Which payment a refund or dispute is about: an Event Pass purchase, an
  // SMS bundle purchase, else the ledger's success row (a subscription
  // charge or a ticket). null when nothing we hold matches.
  findOriginal: async (keys: OriginalPaymentKeys, tx: Prisma.TransactionClient): Promise<OriginalPayment | null> => {
    // A ticket order (ticket sales Round B), by any of its references or its
    // transaction id, once paid.
    const order = await ticketOrderRepository.findOrderByPaymentKeys(keys, tx);
    if (order && order.paidReference) {
      return {
        product: 'TICKET',
        tenantId: order.tenantId,
        eventId: order.eventId,
        relatedType: 'TicketOrder',
        relatedId: order.id,
        reference: order.paidReference,
        transactionId: order.paystackTransactionId ?? keys.transactionId,
        paidCents: order.totalCents,
        currency: order.currency,
        ledgerEntryId: null,
      };
    }
    const pass = await eventPassRepository.findPurchaseByPaymentKeys(keys, tx);
    if (pass) {
      return {
        product: 'EVENT_PASS',
        tenantId: pass.tenantId,
        eventId: pass.eventId,
        relatedType: 'EventPassPurchase',
        relatedId: pass.id,
        reference: pass.paymentRef,
        transactionId: pass.paystackTransactionId ?? keys.transactionId,
        paidCents: pass.amountPaidCents,
        currency: pass.currency,
        ledgerEntryId: null,
      };
    }
    const bundle = await eventPassRepository.findSmsBundlePurchaseByPaymentKeys(keys, tx);
    if (bundle) {
      return {
        product: 'SMS_BUNDLE',
        tenantId: bundle.tenantId,
        eventId: bundle.eventId,
        relatedType: 'EventSmsBundlePurchase',
        relatedId: bundle.id,
        reference: bundle.paymentRef,
        transactionId: bundle.paystackTransactionId ?? keys.transactionId,
        paidCents: bundle.amountPaidCents,
        currency: bundle.currency,
        ledgerEntryId: null,
      };
    }
    const success = await paymentLedgerRepository.findSuccessFor(keys, tx);
    if (success && (success.type === 'SUBSCRIPTION_CHARGE_SUCCEEDED' || success.type === 'TICKET_PAYMENT_SUCCEEDED')) {
      return {
        product: success.type === 'SUBSCRIPTION_CHARGE_SUCCEEDED' ? 'SUBSCRIPTION' : 'TICKET',
        tenantId: success.tenantId,
        eventId: success.eventId,
        relatedType: success.relatedType ?? (success.type === 'SUBSCRIPTION_CHARGE_SUCCEEDED' ? 'Tenant' : 'TicketPurchase'),
        relatedId: success.relatedId ?? success.id,
        reference: success.paystackReference,
        transactionId: success.paystackTransactionId ?? keys.transactionId,
        paidCents: success.amountCents,
        currency: success.currency,
        ledgerEntryId: success.id,
      };
    }
    // A subscription payment that granted nothing (a duplicate, or the
    // wrong amount): a refund of it is matched and takes nothing back.
    const nothingGranted = await findNothingGrantedSubscriptionPayment(keys, tx);
    if (nothingGranted) {
      return {
        product: 'SUBSCRIPTION',
        tenantId: nothingGranted.tenantId,
        eventId: null,
        relatedType: 'Tenant',
        relatedId: nothingGranted.relatedId ?? nothingGranted.id,
        reference: nothingGranted.paystackReference,
        transactionId: nothingGranted.paystackTransactionId ?? keys.transactionId,
        paidCents: nothingGranted.amountCents,
        currency: nothingGranted.currency,
        ledgerEntryId: nothingGranted.id,
        grantedNothing: true,
      };
    }
    return null;
  },

  // Has this exact refund or dispute step already been recorded (a
  // redelivery whose bytes differ)? Keyed by the adjustment's own id in the
  // payload.
  adjustmentRecorded: async (
    type: LedgerEntryType,
    relatedId: string | null,
    adjustmentId: string | null,
    tx: Prisma.TransactionClient
  ): Promise<boolean> => {
    if (!adjustmentId) return false;
    const found = await tx.paymentLedgerEntry.findFirst({
      where: { type, ...(relatedId && { relatedId }), payload: { path: ['adjustmentId'], equals: adjustmentId } },
      select: { id: true },
    });
    return found !== null;
  },
};
