import { type Prisma, type LedgerEntryType } from '@prisma/client';
import { type OriginalPaymentKeys } from '../../shared/payments/paystack-payload.util.js';
import { eventPassRepository } from '../event-pass/event-pass.repository.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { type OriginalPayment } from './payment-adjustment.types.js';

export const paymentAdjustmentRepository = {
  // Which payment a refund or dispute is about: an Event Pass purchase, an
  // SMS bundle purchase, else the ledger's success row (a subscription
  // charge or a ticket). null when nothing we hold matches.
  findOriginal: async (keys: OriginalPaymentKeys, tx: Prisma.TransactionClient): Promise<OriginalPayment | null> => {
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
