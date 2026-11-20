import { type Prisma, type EventPassTier, type LedgerEntryType } from '@prisma/client';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { adjustmentAmountOf, currencyOf, originalPaymentOf } from '../../shared/payments/paystack-payload.util.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { paymentLedgerRepository } from '../payment-ledger/payment-ledger.repository.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import { formatRand, PRODUCT_LABEL } from '../payment-reconciliation/payment-mismatch.util.js';
import { eventPassRepository } from '../event-pass/event-pass.repository.js';
import { EVENT_PASS_TIER_RANK } from '../event-pass/event-pass-plans.config.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { subscriptionRepository } from '../subscription/subscription.repository.js';
import { type WebhookContext, type HandlerResult } from '../payment-webhook/payment-webhook.types.js';
import { paymentAdjustmentRepository } from './payment-adjustment.repository.js';
import { type OriginalPayment, type TakeBackResult } from './payment-adjustment.types.js';

// ─────────────────────────────────────────
//  REFUNDS, REVERSALS AND CHARGEBACKS (payments release 1)
//
//  Refunds are issued by the super admin from Paystack's dashboard; the app
//  only reacts to what Paystack reports. Every event is matched to the
//  original payment (our reference, else Paystack's transaction id),
//  recorded in the ledger against it, and applied per the decisions:
//
//   Subscription refunded (the tenant's latest subscription charge, in full):
//     access ends at once (Spark, all data kept); the Paystack subscription
//     is disabled after commit (or by the sync, if that fails).
//   Event Pass refunded: that purchase is REFUNDED and the event's pass is
//     recomputed from what is still PAID: no paid fresh purchase left → the
//     pass is removed and the event falls back to its tenant's plan;
//     otherwise the highest still-paid tier. Nothing of the event is deleted.
//   SMS bundle refunded: REFUNDED, so its credits stop counting; credits
//     already sent stay sent, what was left of them is gone.
//   Ticket refunded: recorded only (ticket handling is a later release);
//     the super admin is alerted to deal with the guest's access.
//   A PARTIAL refund (less than was paid): recorded and alerted, nothing
//     taken back; a person decides.
//   Chargeback opened: recorded, access stays, super admin alerted.
//     Reminders: recorded. Resolved lost: taken back exactly like a refund,
//     status REVERSED. Resolved won: recorded, nothing changes.
//
//  [Payload shapes unverified against Paystack's own pages, which refused
//  automated reads: the original transaction is read from
//  data.transaction_reference, data.transaction.reference, data.transaction.id
//  or a bare data.transaction; a dispute's outcome from data.resolution
//  ("merchant-accepted" lost, "declined" won). An outcome we don't recognise
//  changes nothing and is alerted. See STEERING "Payments" for how to check
//  the real payloads in test mode.]
// ─────────────────────────────────────────

const REFUND_LEDGER_TYPE: Record<string, LedgerEntryType> = {
  'refund.processed': 'REFUND_ISSUED',
  'refund.pending': 'REFUND_PENDING',
  'refund.processing': 'REFUND_PENDING',
  'refund.failed': 'REFUND_FAILED',
};

export const REFUND_EVENTS = Object.keys(REFUND_LEDGER_TYPE);
export const DISPUTE_EVENTS = ['charge.dispute.create', 'charge.dispute.remind', 'charge.dispute.resolve'];

const LOST_RESOLUTIONS = new Set(['merchant-accepted', 'lost', 'accepted']);
const WON_RESOLUTIONS = new Set(['declined', 'won', 'merchant-won']);

const TIER_LABEL: Record<EventPassTier, string> = { SMALL: 'Small', STANDARD: 'Standard', LARGE: 'Large' };

const adjustmentIdOf = (data: Record<string, unknown>): string | null => {
  const id = data['id'];
  return typeof id === 'number' || (typeof id === 'string' && id) ? String(id) : null;
};

const factsFor = (original: OriginalPayment | null, amountCents: number | null, currency: string): string[] => [
  `Payment: ${original ? PRODUCT_LABEL[original.product] : 'not found'}`,
  `Reference: ${original?.reference ?? 'unknown'}`,
  `Amount: ${formatRand(amountCents, currency)}${original ? ` of ${formatRand(original.paidCents, original.currency)} paid` : ''}`,
  ...(original?.tenantId ? [`Tenant: ${original.tenantId}`] : []),
  ...(original?.eventId ? [`Event: ${original.eventId}`] : []),
];

// Takes back what a payment bought (a full refund, a lost chargeback).
// Idempotent: a purchase already REFUNDED or REVERSED is left as it is.
const takeBack = async (
  ctx: WebhookContext,
  original: OriginalPayment,
  status: 'REFUNDED' | 'REVERSED'
): Promise<TakeBackResult> => {
  const { tx } = ctx;

  if (original.product === 'EVENT_PASS') {
    const purchase = await tx.eventPassPurchase.findUnique({ where: { id: original.relatedId } });
    if (!purchase) return { effect: 'NOTHING_WAS_GRANTED', details: {} };
    if (purchase.status === 'REFUNDED' || purchase.status === 'REVERSED') return { effect: 'ALREADY_TAKEN_BACK', details: { status: purchase.status } };
    const wasPaid = purchase.status === 'PAID';
    await eventPassRepository.markPurchaseTakenBack(purchase.id, status, tx);
    if (!wasPaid) return { effect: 'NOTHING_WAS_GRANTED', details: { previousStatus: purchase.status } };

    const before = await eventPassRepository.findByEventId(purchase.eventId, tx);
    const remaining = await eventPassRepository.findPaidPurchasesForEvent(purchase.eventId, tx);
    const hasFreshPurchase = remaining.some((p) => !p.isUpgrade);
    if (!hasFreshPurchase) {
      await eventPassRepository.removePass(purchase.eventId, tx);
      return { effect: 'PASS_REMOVED', details: { previousTier: before?.passTier ?? null } };
    }
    const highest = remaining.reduce<EventPassTier>(
      (best, p) => (EVENT_PASS_TIER_RANK[p.passTier] > EVENT_PASS_TIER_RANK[best] ? p.passTier : best),
      remaining[0]!.passTier
    );
    if (before && before.passTier !== highest) {
      await eventPassRepository.setPassTier(purchase.eventId, highest, tx);
      return { effect: 'PASS_LOWERED', details: { previousTier: before.passTier, newTier: highest } };
    }
    return { effect: 'PASS_UNCHANGED', details: { tier: before?.passTier ?? highest } };
  }

  if (original.product === 'SMS_BUNDLE') {
    const purchase = await tx.eventSmsBundlePurchase.findUnique({ where: { id: original.relatedId } });
    if (!purchase) return { effect: 'NOTHING_WAS_GRANTED', details: {} };
    if (purchase.status === 'REFUNDED' || purchase.status === 'REVERSED') return { effect: 'ALREADY_TAKEN_BACK', details: { status: purchase.status } };
    const wasPaid = purchase.status === 'PAID';
    const purchasedBefore = wasPaid ? await eventPassRepository.sumPaidBundleSmsForEvent(purchase.eventId, tx) : 0;
    const used = wasPaid ? await smsSendLogRepository.countBundleUsedForEvent(purchase.eventId) : 0;
    await eventPassRepository.markSmsBundleTakenBack(purchase.id, status, tx);
    if (!wasPaid) return { effect: 'NOTHING_WAS_GRANTED', details: { previousStatus: purchase.status } };
    const remainingBefore = Math.max(purchasedBefore - used, 0);
    const remainingAfter = Math.max(purchasedBefore - purchase.smsCount - used, 0);
    return {
      effect: 'SMS_CREDITS_REMOVED',
      details: { smsCount: purchase.smsCount, creditsRemoved: remainingBefore - remainingAfter, remainingAfter },
    };
  }

  if (original.product === 'SUBSCRIPTION') {
    if (!original.tenantId) return { effect: 'NOTHING_WAS_GRANTED', details: {} };
    const latest = await paymentLedgerRepository.findLatestSubscriptionCharge(original.tenantId, tx);
    if (!latest || latest.id !== original.ledgerEntryId) {
      return { effect: 'SUBSCRIPTION_NOT_CURRENT_CHARGE', details: { latestChargeId: latest?.id ?? null } };
    }
    const tenant = await subscriptionRepository.findBillingStateByTenantId(original.tenantId, tx);
    if (!tenant) return { effect: 'NOTHING_WAS_GRANTED', details: {} };
    if (tenant.subscriptionTier === 'SPARK') return { effect: 'ALREADY_TAKEN_BACK', details: {} };

    await subscriptionRepository.endSubscriptionNow(tenant.id, tx);
    await paymentLedgerService.record(
      {
        type: 'SUBSCRIPTION_TIER_CHANGED',
        amountCents: 0,
        currency: 'ZAR',
        tenantId: tenant.id,
        paystackReference: tenant.paystackSubscriptionCode,
        relatedType: 'Tenant',
        relatedId: tenant.id,
        payload: {
          from: { tier: tenant.subscriptionTier, period: tenant.subscriptionPeriod },
          to: { tier: 'SPARK', period: null },
          reason: status === 'REFUNDED' ? 'REFUNDED' : 'CHARGEBACK_LOST',
        } as unknown as Prisma.InputJsonValue,
      },
      tx
    );

    const code = tenant.paystackSubscriptionCode;
    const token = tenant.paystackSubscriptionEmailToken;
    if (code && token) {
      ctx.after(async () => {
        try {
          await paystackClient.disableSubscription(code, token);
          await subscriptionRepository.clearSubscriptionCodes(tenant.id, code);
        } catch (err) {
          // Left flagged (endSubscriptionNow set subscriptionNeedsSync): the
          // hourly sync retries the disable.
          console.error(`[refund] could not disable subscription ${code} for tenant ${tenant.id}; left for the sync:`, err);
        }
      });
    }
    return {
      effect: 'SUBSCRIPTION_ENDED',
      details: { previousTier: tenant.subscriptionTier, previousPeriod: tenant.subscriptionPeriod, subscriptionCode: code },
    };
  }

  return { effect: 'TICKET_NOT_CHANGED', details: {} };
};

const record = (
  ctx: WebhookContext,
  type: LedgerEntryType,
  original: OriginalPayment | null,
  amountCents: number | null,
  currency: string,
  payload: Record<string, unknown>
) =>
  paymentLedgerService.record(
    {
      type,
      amountCents: amountCents ?? 0,
      currency,
      tenantId: original?.tenantId ?? null,
      eventId: original?.eventId ?? null,
      paystackReference: original?.reference ?? null,
      paystackTransactionId: original?.transactionId ?? null,
      relatedType: original?.relatedType ?? 'webhook',
      relatedId: original?.relatedId ?? ctx.event,
      payload: { ...payload, provider: ctx.payload } as unknown as Prisma.InputJsonValue,
    },
    ctx.tx
  );

export const paymentAdjustmentService = {
  // refund.processed / refund.pending / refund.processing / refund.failed
  handleRefundWithinTransaction: async (ctx: WebhookContext): Promise<HandlerResult> => {
    const { data, tx } = ctx;
    const type = REFUND_LEDGER_TYPE[ctx.event];
    if (!type) return { claimed: false };

    const keys = originalPaymentOf(data);
    const original = await paymentAdjustmentRepository.findOriginal(keys, tx);
    const amountCents = adjustmentAmountOf(data);
    const currency = currencyOf(data) ?? original?.currency ?? 'ZAR';
    const adjustmentId = adjustmentIdOf(data);

    if (await paymentAdjustmentRepository.adjustmentRecorded(type, original?.relatedId ?? null, adjustmentId, tx)) {
      return { claimed: true };
    }

    if (!original) {
      await record(ctx, type, null, amountCents, currency, { adjustmentId, keys, matched: false });
      if (type !== 'REFUND_PENDING') {
        ctx.after(async () => {
          await paymentAlertService.send({
            kind: 'REFUND',
            subject: 'A refund matched no payment we know',
            lines: ['Paystack reported a refund for a payment e-velope has no record of. Check it in the dashboard.'],
            facts: [`Event: ${ctx.event}`, `Transaction: ${keys.reference ?? keys.transactionId ?? 'unknown'}`, `Amount: ${formatRand(amountCents, currency)}`],
          });
        });
      }
      return { claimed: true };
    }

    if (type === 'REFUND_PENDING') {
      await record(ctx, type, original, amountCents, currency, { adjustmentId, product: original.product });
      return { claimed: true };
    }

    if (type === 'REFUND_FAILED') {
      await record(ctx, type, original, amountCents, currency, { adjustmentId, product: original.product });
      ctx.after(async () => {
        await paymentAlertService.send({
          kind: 'REFUND',
          subject: `A ${PRODUCT_LABEL[original.product]} refund failed`,
          lines: ["Paystack couldn't complete this refund. Nothing was taken back. Check it in Paystack's dashboard."],
          facts: factsFor(original, amountCents, currency),
        });
      });
      return { claimed: true };
    }

    // refund.processed
    const full = amountCents === null || amountCents >= original.paidCents;
    const result: TakeBackResult = full
      ? await takeBack(ctx, original, 'REFUNDED')
      : { effect: 'PARTIAL_RECORDED_ONLY', details: {} };
    await record(ctx, 'REFUND_ISSUED', original, amountCents, currency, {
      adjustmentId,
      product: original.product,
      full,
      effect: result.effect,
      ...result.details,
    });

    const needsPerson = !full || result.effect === 'SUBSCRIPTION_NOT_CURRENT_CHARGE' || result.effect === 'TICKET_NOT_CHANGED';
    if (needsPerson) {
      ctx.after(async () => {
        await paymentAlertService.send({
          kind: 'REFUND',
          subject: `A ${PRODUCT_LABEL[original.product]} refund needs a decision`,
          lines: [
            !full
              ? 'This was a partial refund, so nothing was taken back automatically.'
              : result.effect === 'TICKET_NOT_CHANGED'
                ? "Ticket refunds are recorded but don't yet change the guest's ticket."
                : "This refund is for an earlier subscription payment, not the latest one, so the subscription wasn't ended.",
            'Decide what the customer keeps, and change it by hand if needed.',
          ],
          facts: factsFor(original, amountCents, currency),
        });
      });
    }
    return { claimed: true };
  },

  // charge.dispute.create / .remind / .resolve
  handleDisputeWithinTransaction: async (ctx: WebhookContext): Promise<HandlerResult> => {
    const { data, tx } = ctx;
    const keys = originalPaymentOf(data);
    const original = await paymentAdjustmentRepository.findOriginal(keys, tx);
    const amountCents = adjustmentAmountOf(data);
    const currency = currencyOf(data) ?? original?.currency ?? 'ZAR';
    const disputeId = adjustmentIdOf(data);
    const dueAt = data['dueAt'] ?? data['due_at'] ?? null;
    const status = typeof data['status'] === 'string' ? data['status'] : null;

    if (ctx.event === 'charge.dispute.create') {
      if (await paymentAdjustmentRepository.adjustmentRecorded('DISPUTE_OPENED', original?.relatedId ?? null, disputeId, tx)) return { claimed: true };
      await record(ctx, 'DISPUTE_OPENED', original, amountCents, currency, { adjustmentId: disputeId, product: original?.product ?? null, status, dueAt, keys });
      ctx.after(async () => {
        await paymentAlertService.send({
          kind: 'DISPUTE',
          subject: original ? `Chargeback opened on a ${PRODUCT_LABEL[original.product]} payment` : 'Chargeback opened on an unknown payment',
          lines: [
            "A customer's bank has disputed this payment. Access stays as it is for now.",
            `Respond in Paystack's dashboard${typeof dueAt === 'string' ? ` before ${dueAt}` : ' before the deadline'}, with proof of what was bought.`,
          ],
          facts: factsFor(original, amountCents, currency),
        });
      });
      return { claimed: true };
    }

    if (ctx.event === 'charge.dispute.remind') {
      await record(ctx, 'DISPUTE_REMINDER', original, amountCents, currency, { adjustmentId: disputeId, status, dueAt });
      return { claimed: true };
    }

    // charge.dispute.resolve
    const resolution = typeof data['resolution'] === 'string' ? data['resolution'].toLowerCase() : null;
    const lost = resolution !== null && LOST_RESOLUTIONS.has(resolution);
    const won = resolution !== null && WON_RESOLUTIONS.has(resolution);

    if (lost) {
      if (await paymentAdjustmentRepository.adjustmentRecorded('DISPUTE_LOST', original?.relatedId ?? null, disputeId, tx)) return { claimed: true };
      const full = original !== null && (amountCents === null || amountCents >= original.paidCents);
      const result: TakeBackResult = original && full
        ? await takeBack(ctx, original, 'REVERSED')
        : { effect: 'PARTIAL_RECORDED_ONLY', details: {} };
      await record(ctx, 'DISPUTE_LOST', original, amountCents, currency, {
        adjustmentId: disputeId,
        resolution,
        product: original?.product ?? null,
        full,
        effect: result.effect,
        ...result.details,
      });
      ctx.after(async () => {
        await paymentAlertService.send({
          kind: 'DISPUTE',
          subject: original ? `Chargeback lost on a ${PRODUCT_LABEL[original.product]} payment` : 'Chargeback lost on an unknown payment',
          lines: [
            result.effect === 'PARTIAL_RECORDED_ONLY'
              ? 'The bank decided against us for part of the payment (or a payment we can’t find). Nothing was taken back automatically: decide what the customer keeps.'
              : 'The bank decided against us. What the payment bought has been taken back, as for a refund.',
          ],
          facts: [...factsFor(original, amountCents, currency), `Outcome: ${result.effect}`],
        });
      });
      return { claimed: true };
    }

    if (won) {
      await record(ctx, 'DISPUTE_WON', original, amountCents, currency, { adjustmentId: disputeId, resolution, product: original?.product ?? null });
      ctx.after(async () => {
        await paymentAlertService.send({
          kind: 'DISPUTE',
          subject: 'Chargeback won',
          lines: ['The bank decided in our favour. Nothing changes for the customer.'],
          facts: factsFor(original, amountCents, currency),
        });
      });
      return { claimed: true };
    }

    await record(ctx, 'WEBHOOK_EVENT_IGNORED', original, amountCents, currency, {
      reason: 'UNKNOWN_DISPUTE_RESOLUTION',
      adjustmentId: disputeId,
      resolution,
      status,
    });
    ctx.after(async () => {
      await paymentAlertService.send({
        kind: 'DISPUTE',
        subject: 'A chargeback was resolved with an outcome we don’t recognise',
        lines: [`Paystack reported the resolution "${resolution ?? 'none'}". Nothing was changed. Check the outcome in Paystack's dashboard and act by hand.`],
        facts: factsFor(original, amountCents, currency),
      });
    });
    return { claimed: true };
  },
};

export { TIER_LABEL as EVENT_PASS_TIER_LABEL };
