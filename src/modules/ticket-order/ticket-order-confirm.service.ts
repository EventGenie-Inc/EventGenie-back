import crypto from 'crypto';
import { type IssuedTicketStatus, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { checkAmount, paidAtOf, transactionIdOf } from '../../shared/payments/paystack-payload.util.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import { recordAmountMismatch, recordDuplicatePayment, formatRand } from '../payment-reconciliation/payment-mismatch.util.js';
import { paymentReconciliationRepository } from '../payment-reconciliation/payment-reconciliation.repository.js';
import { type WebhookContext } from '../payment-webhook/payment-webhook.types.js';
import { PAYMENT_TRANSACTION_OPTIONS, runPostCommit, type PostCommitWork } from '../payment-webhook/payment-context.util.js';
import { ticketOrderRepository, type OrderRow } from './ticket-order.repository.js';
import { ticketOrderEmails } from './ticket-order-emails.js';

// ─────────────────────────────────────────
//  CONFIRMING A TICKET ORDER (ticket sales Round B; STEERING "Ticket sales")
//
//  charge.success (the webhook) and a verify (the order status page) both
//  come here, inside one transaction with the order's row locked, so two
//  arriving together confirm it once. By the paid reference:
//   - a reference already handled: nothing (a redelivery);
//   - the order already paid through ANOTHER reference: a second payment,
//     PAYMENT_DUPLICATE for the super admin (a dashboard refund), no tickets;
//   - the amount, currency, subaccount or split not the order's snapshot:
//     UNDER_REVIEW (PAYMENT_MISMATCH), alerted, no tickets, its stock freed;
//   - otherwise PAID: the hold becomes sold stock (or, paid after the hold
//     lapsed, sold anyway: never refuse a paid order; an oversell is flagged
//     to the organisation's admins and the super admin), one IssuedTicket per
//     unit with a short number, and the ledger: TICKET_PAYMENT_SUCCEEDED with
//     Paystack's actual fee and its difference from the calculated one, and
//     COMMISSION_TAKEN. e-velope's net below zero (the fee above its charge
//     minus the commission) is a PaymentMismatch and an alert.
//  The buyer's email (tickets, PDF) goes after commit, claimed once.
// ─────────────────────────────────────────

export type TicketConfirmOutcome = 'confirmed' | 'already_handled' | 'not_found' | 'under_review' | 'duplicate';

// Paystack's subaccount on a split payment: { subaccount_code } or a bare code.
const subaccountOf = (data: Record<string, unknown>): string | null => {
  const sub = data['subaccount'];
  if (typeof sub === 'string') return sub || null;
  if (sub && typeof sub === 'object') {
    const code = (sub as Record<string, unknown>)['subaccount_code'];
    return typeof code === 'string' ? code : null;
  }
  return null;
};

// What the subaccount received and the charge kept, when Paystack says.
const splitOf = (data: Record<string, unknown>): { subaccountCents: number | null; transactionChargeCents: number | null } => {
  const split = data['fees_split'];
  if (!split || typeof split !== 'object') return { subaccountCents: null, transactionChargeCents: null };
  const s = split as Record<string, unknown>;
  const params = (s['params'] && typeof s['params'] === 'object' ? s['params'] : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
  return { subaccountCents: num(s['subaccount']), transactionChargeCents: num(params['transaction_charge']) };
};

const feesOf = (data: Record<string, unknown>): number | null => (typeof data['fees'] === 'number' ? (data['fees'] as number) : null);

// "TK-7QK4-M2XP": no 0/O, 1/I/L. 32^8 ≈ 10^12 per prefix; unique index too.
const NUMBER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newTicketNumber = (): string => {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => NUMBER_ALPHABET[b % NUMBER_ALPHABET.length]).join('');
  return `TK-${chars.slice(0, 4)}-${chars.slice(4)}`;
};

const releaseHoldWithinTransaction = async (tx: Prisma.TransactionClient, orderId: string): Promise<void> => {
  const order = await tx.ticketOrder.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.holdReleasedAt !== null) return;
  for (const item of order.items) await ticketOrderRepository.releaseHold(tx, item.ticketTypeId, item.quantity);
  await tx.ticketOrder.update({ where: { id: orderId }, data: { holdReleasedAt: new Date() } });
};

// The tickets of an order that are still VALID become `status`, freeing
// their places. Returns how many were voided.
const voidTickets = async (
  tx: Prisma.TransactionClient,
  order: OrderRow,
  status: Exclude<IssuedTicketStatus, 'VALID'>,
  ticketIds: string[] | null,
  extra: { cancelReason?: string; cancelledByUserId?: string } = {}
): Promise<string[]> => {
  const targets = order.tickets.filter((t) => t.status === 'VALID' && (ticketIds === null || ticketIds.includes(t.id)));
  if (targets.length === 0) return [];
  const now = new Date();
  await tx.issuedTicket.updateMany({
    where: { id: { in: targets.map((t) => t.id) }, status: 'VALID' },
    data: { status, voidedAt: now, ...extra },
  });
  const perType = new Map<string, number>();
  for (const t of targets) perType.set(t.ticketTypeId, (perType.get(t.ticketTypeId) ?? 0) + 1);
  for (const [typeId, count] of perType) await ticketOrderRepository.unsell(tx, typeId, count);
  return targets.map((t) => t.id);
};

export const ticketOrderConfirmService = {
  releaseHoldWithinTransaction,
  voidTickets,

  confirmWithinTransaction: async (ctx: WebhookContext, reference: string): Promise<{ outcome: TicketConfirmOutcome }> => {
    const { tx, data } = ctx;
    const payment = await ticketOrderRepository.findPaymentByReference(reference, tx);
    if (!payment) return { outcome: 'not_found' };
    await ticketOrderRepository.lock(tx, payment.orderId);
    const order = (await ticketOrderRepository.findById(payment.orderId, tx))!;
    const current = order.payments.find((p) => p.reference === reference)!;
    if (current.status === 'SUCCEEDED' || current.status === 'DUPLICATE' || current.status === 'MISMATCH') return { outcome: 'already_handled' };

    const transactionId = transactionIdOf(data);
    const occurredAt = paidAtOf(data);

    // Paid already, through another reference: a second payment.
    if (order.paidReference && order.paidReference !== reference) {
      await tx.ticketOrderPayment.update({ where: { id: current.id }, data: { status: 'DUPLICATE' } });
      await recordDuplicatePayment(ctx, {
        product: 'TICKET',
        reference,
        transactionId,
        tenantId: order.tenantId,
        eventId: order.eventId,
        relatedType: 'TicketOrder',
        relatedId: order.id,
        amountCents: order.totalCents,
        currency: order.currency,
        ...(occurredAt && { occurredAt }),
        duplicates: { reference: order.paidReference, relatedId: order.id, description: `ticket order ${order.id} for this event` },
      });
      return { outcome: 'duplicate' };
    }

    // The money, the subaccount and the split, against the snapshot.
    const amount = checkAmount(data, order.totalCents, order.currency);
    const subaccount = subaccountOf(data);
    const split = splitOf(data);
    const splitProblems: string[] = [];
    if (subaccount !== order.subaccountCode) splitProblems.push(`subaccount ${subaccount ?? 'missing'}, expected ${order.subaccountCode}`);
    if (split.subaccountCents !== null && split.subaccountCents !== order.subtotalCents) {
      splitProblems.push(`subaccount share ${split.subaccountCents}, expected ${order.subtotalCents}`);
    }
    if (split.transactionChargeCents !== null && split.transactionChargeCents !== order.transactionChargeCents) {
      splitProblems.push(`transaction charge ${split.transactionChargeCents}, expected ${order.transactionChargeCents}`);
    }

    if (!amount.ok || splitProblems.length > 0) {
      await tx.ticketOrderPayment.update({ where: { id: current.id }, data: { status: 'MISMATCH' } });
      await tx.ticketOrder.update({
        where: { id: order.id },
        data: { status: 'UNDER_REVIEW', reviewReason: 'PAYMENT_MISMATCH', paidReference: reference, paystackTransactionId: transactionId },
      });
      await releaseHoldWithinTransaction(tx, order.id);
      if (!amount.ok) {
        await recordAmountMismatch(ctx, {
          product: 'TICKET',
          reference,
          transactionId,
          tenantId: order.tenantId,
          eventId: order.eventId,
          relatedType: 'TicketOrder',
          relatedId: order.id,
          check: amount,
        });
      } else {
        await paymentLedgerService.record(
          {
            type: 'PAYMENT_AMOUNT_MISMATCH',
            amountCents: order.totalCents,
            currency: order.currency,
            tenantId: order.tenantId,
            eventId: order.eventId,
            paystackReference: reference,
            paystackTransactionId: transactionId,
            relatedType: 'TicketOrder',
            relatedId: order.id,
            payload: { product: 'TICKET', reason: 'SPLIT_MISMATCH', problems: splitProblems, provider: ctx.payload } as unknown as Prisma.InputJsonValue,
          },
          tx
        );
        await paymentReconciliationRepository.createMismatch(
          {
            source: 'WEBHOOK',
            kind: 'SPLIT_MISMATCH',
            paystackReference: reference,
            paystackTransactionId: transactionId,
            tenantId: order.tenantId,
            eventId: order.eventId,
            expectedAmountCents: order.subtotalCents,
            actualAmountCents: split.subaccountCents,
            currency: order.currency,
            details: { product: 'TICKET', relatedType: 'TicketOrder', relatedId: order.id, problems: splitProblems },
          },
          tx
        );
        ctx.after(async () => {
          await paymentAlertService.send({
            kind: 'AMOUNT_MISMATCH',
            subject: "A ticket payment's split didn't match its order",
            lines: [
              'The payment was recorded and the order is under review: no tickets were issued.',
              "Check the payment in Paystack's dashboard, and refund it there if needed.",
            ],
            facts: [`Reference: ${reference}`, `Order: ${order.id}`, `Event: ${order.eventId}`, ...splitProblems],
          });
        });
      }
      return { outcome: 'under_review' };
    }

    // ── Paid ──
    const fromHold = order.holdReleasedAt === null;
    for (const item of order.items) await ticketOrderRepository.sell(tx, item.ticketTypeId, item.quantity, fromHold);
    let oversold = false;
    for (const item of order.items) if (await ticketOrderRepository.isOversold(tx, item.ticketTypeId)) oversold = true;

    let index = 0;
    const count = order.items.reduce((sum, i) => sum + i.quantity, 0);
    for (const item of order.items) {
      for (let n = 0; n < item.quantity; n++) {
        index++;
        await tx.issuedTicket.create({
          data: { orderId: order.id, eventId: order.eventId, ticketTypeId: item.ticketTypeId, orderItemId: item.id, number: newTicketNumber(), indexInOrder: index },
        });
      }
    }

    const actualFeeCents = feesOf(data);
    const now = new Date();
    await tx.ticketOrderPayment.update({ where: { id: current.id }, data: { status: 'SUCCEEDED' } });
    await tx.ticketOrder.update({
      where: { id: order.id },
      data: {
        status: 'PAID',
        reviewReason: null,
        paidAt: occurredAt ?? now,
        paidReference: reference,
        paystackTransactionId: transactionId,
        actualFeeCents,
        oversold,
        holdReleasedAt: order.holdReleasedAt ?? now,
      },
    });

    const feeDifferenceCents = actualFeeCents === null ? null : actualFeeCents - order.processingFeeCents;
    // e-velope's net beyond its commission: its charge, less the commission,
    // less what Paystack actually took.
    const netCents = actualFeeCents === null ? null : order.transactionChargeCents - order.commissionCents - actualFeeCents;
    await paymentLedgerService.record(
      {
        type: 'TICKET_PAYMENT_SUCCEEDED',
        amountCents: order.totalCents,
        currency: order.currency,
        tenantId: order.tenantId,
        eventId: order.eventId,
        paystackReference: reference,
        paystackTransactionId: transactionId,
        relatedType: 'TicketOrder',
        relatedId: order.id,
        ...(occurredAt && { occurredAt }),
        payload: {
          tickets: count,
          subtotalCents: order.subtotalCents,
          commissionCents: order.commissionCents,
          platformFixedFeeCents: order.platformFixedFeeCents,
          transactionChargeCents: order.transactionChargeCents,
          calculatedProcessingFeeCents: order.processingFeeCents,
          actualFeeCents,
          feeDifferenceCents,
          netCents,
          subaccountCode: order.subaccountCode,
          lateAfterHold: !fromHold,
          oversold,
          provider: ctx.payload,
        } as unknown as Prisma.InputJsonValue,
      },
      tx
    );
    await paymentLedgerService.record(
      {
        type: 'COMMISSION_TAKEN',
        amountCents: order.commissionCents + order.platformFixedFeeCents,
        currency: order.currency,
        tenantId: order.tenantId,
        eventId: order.eventId,
        paystackReference: reference,
        paystackTransactionId: transactionId,
        relatedType: 'TicketOrder',
        relatedId: order.id,
        payload: { commissionCents: order.commissionCents, platformFixedFeeCents: order.platformFixedFeeCents } as unknown as Prisma.InputJsonValue,
      },
      tx
    );

    if (netCents !== null && netCents < 0) {
      await paymentReconciliationRepository.createMismatch(
        {
          source: 'WEBHOOK',
          kind: 'NEGATIVE_NET',
          paystackReference: reference,
          paystackTransactionId: transactionId,
          tenantId: order.tenantId,
          eventId: order.eventId,
          expectedAmountCents: order.processingFeeCents,
          actualAmountCents: actualFeeCents,
          currency: order.currency,
          details: { product: 'TICKET', relatedType: 'TicketOrder', relatedId: order.id, netCents, transactionChargeCents: order.transactionChargeCents, commissionCents: order.commissionCents },
        },
        tx
      );
      ctx.after(async () => {
        await paymentAlertService.send({
          kind: 'RECONCILIATION',
          subject: "A ticket payment's fee was more than we charged for it",
          lines: [
            `Paystack's fee (${formatRand(actualFeeCents)}) was above e-velope's charge less the commission, so e-velope lost ${formatRand(-netCents)} on this order.`,
            "Usually an international card or another channel dearer than a local card. Check the payment's channel in Paystack.",
          ],
          facts: [`Reference: ${reference}`, `Order: ${order.id}`, `Charge: ${formatRand(order.transactionChargeCents)}`, `Commission: ${formatRand(order.commissionCents)}`],
        });
      });
    }

    if (oversold) {
      ctx.after(async () => {
        await ticketOrderEmails.oversold(order.id);
      });
    }
    ctx.after(async () => {
      await ticketOrderEmails.sendConfirmation(order.id);
    });
    return { outcome: 'confirmed' };
  },

  // charge.failed (or a verify saying failed or abandoned): that attempt is
  // FAILED; if it was the order's latest and the order still PENDING, the
  // order is FAILED and its hold given back. A success later is still
  // honoured (confirmWithinTransaction).
  failWithinTransaction: async (ctx: WebhookContext, reference: string): Promise<{ outcome: 'failed' | 'already_handled' | 'not_found' }> => {
    const { tx } = ctx;
    const payment = await ticketOrderRepository.findPaymentByReference(reference, tx);
    if (!payment) return { outcome: 'not_found' };
    await ticketOrderRepository.lock(tx, payment.orderId);
    const order = (await ticketOrderRepository.findById(payment.orderId, tx))!;
    const current = order.payments.find((p) => p.reference === reference)!;
    if (current.status !== 'INITIATED') return { outcome: 'already_handled' };
    await tx.ticketOrderPayment.update({ where: { id: current.id }, data: { status: 'FAILED' } });
    const latest = order.payments[order.payments.length - 1]!;
    if (order.status === 'PENDING' && latest.reference === reference) {
      await tx.ticketOrder.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      await releaseHoldWithinTransaction(tx, order.id);
    }
    await paymentLedgerService.record(
      {
        type: 'TICKET_PAYMENT_FAILED',
        amountCents: order.totalCents,
        currency: order.currency,
        tenantId: order.tenantId,
        eventId: order.eventId,
        paystackReference: reference,
        relatedType: 'TicketOrder',
        relatedId: order.id,
        payload: ctx.payload,
      },
      tx
    );
    return { outcome: 'failed' };
  },

  // The expiry job: orders still unpaid when their hold ran out give their
  // stock back; a PENDING one becomes EXPIRED. A success later still goes
  // through (an oversell then flagged).
  expireDue: async (now: Date = new Date(), eventIds?: string[]): Promise<number> => {
    let expired = 0;
    for (const { id } of await ticketOrderRepository.findExpired(now, eventIds)) {
      const changed = await prisma.$transaction(async (tx) => {
        await ticketOrderRepository.lock(tx, id);
        const order = await tx.ticketOrder.findUnique({ where: { id } });
        if (!order || order.holdReleasedAt !== null || order.holdExpiresAt > now) return false;
        if (order.status !== 'PENDING' && order.status !== 'FAILED') return false;
        await releaseHoldWithinTransaction(tx, id);
        if (order.status === 'PENDING') await tx.ticketOrder.update({ where: { id }, data: { status: 'EXPIRED' } });
        return true;
      }, PAYMENT_TRANSACTION_OPTIONS);
      if (changed) expired++;
    }
    return expired;
  },

  // A full refund or a lost chargeback (payment-adjustment.service.ts): every
  // ticket still VALID is voided (its QR stops working, its place is freed),
  // and the order is REFUNDED or REVERSED. Idempotent.
  takeBackWithinTransaction: async (
    ctx: WebhookContext,
    orderId: string,
    status: 'REFUNDED' | 'REVERSED'
  ): Promise<{ voided: number; alreadyTakenBack: boolean }> => {
    const { tx } = ctx;
    await ticketOrderRepository.lock(tx, orderId);
    const order = (await ticketOrderRepository.findById(orderId, tx))!;
    if (order.status === 'REFUNDED' || order.status === 'REVERSED') return { voided: 0, alreadyTakenBack: true };
    const voided = await voidTickets(tx, order, status, null);
    await tx.ticketOrder.update({
      where: { id: orderId },
      data: { status, ...(status === 'REVERSED' && { disputeStatus: 'LOST' }), reviewReason: null },
    });
    return { voided: voided.length, alreadyTakenBack: false };
  },

  // A chargeback opened: UNDER_REVIEW (DISPUTE), the tickets stay valid.
  disputeOpenedWithinTransaction: async (ctx: WebhookContext, orderId: string): Promise<void> => {
    await ticketOrderRepository.lock(ctx.tx, orderId);
    await ctx.tx.ticketOrder.updateMany({
      where: { id: orderId, status: { in: ['PAID', 'UNDER_REVIEW'] }, OR: [{ reviewReason: null }, { reviewReason: 'DISPUTE' }] },
      data: { status: 'UNDER_REVIEW', reviewReason: 'DISPUTE', disputeStatus: 'OPEN' },
    });
  },

  // Won: back to normal.
  disputeWonWithinTransaction: async (ctx: WebhookContext, orderId: string): Promise<void> => {
    await ticketOrderRepository.lock(ctx.tx, orderId);
    await ctx.tx.ticketOrder.updateMany({
      where: { id: orderId, status: 'UNDER_REVIEW', reviewReason: 'DISPUTE' },
      data: { status: 'PAID', reviewReason: null, disputeStatus: 'WON' },
    });
    await ctx.tx.ticketOrder.updateMany({ where: { id: orderId, disputeStatus: 'OPEN' }, data: { disputeStatus: 'WON' } });
  },

  // For the worker: confirmation emails still unsent.
  sendPendingConfirmations: async (now: Date = new Date(), eventIds?: string[]): Promise<number> => {
    let sent = 0;
    for (const { id } of await ticketOrderRepository.findUnsentConfirmations(now, eventIds)) {
      if (await ticketOrderEmails.sendConfirmation(id, now)) sent++;
    }
    return sent;
  },

  // Runs post-commit work collected outside a webhook (tests, the verify).
  runAfter: async (work: PostCommitWork[]): Promise<void> => runPostCommit(work),
};
