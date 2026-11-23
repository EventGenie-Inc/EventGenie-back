import { type PaymentLedgerEntry, type LedgerEntryType } from '@prisma/client';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PaystackApiError } from '../../shared/payments/paystack.client.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import prisma from '../../shared/prisma/prisma.client.js';
import { cardVerificationChargeOf, cardVerificationRefundOf } from '../../shared/payments/card-verification.util.js';
import { paymentAdjustmentRepository } from '../payment-adjustment/payment-adjustment.repository.js';
import { paymentLedgerRepository, LEDGER_SUCCESS_TYPES } from '../payment-ledger/payment-ledger.repository.js';
import { paymentAlertService } from '../payment-alert/payment-alert.service.js';
import { paymentReconciliationRepository } from './payment-reconciliation.repository.js';
import { formatRand, isTicketLoss } from './payment-mismatch.util.js';
import {
  type CreateMismatchInput,
  type ReconciliationResult,
  type MismatchDto,
  type ReconciliationRunDto,
  type LedgerEntryDto,
  type Page,
} from './payment-reconciliation.types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

// The day's ticket fee differences (Paystack's actual fee less the calculated
// processing fee, as each TICKET_PAYMENT_SUCCEEDED row recorded it): their
// total and how many there were, for the super admin's run summary. A
// positive total is what Paystack took beyond the estimate (international
// cards), paid out of e-velope's commission.
const ticketFeeDifferences = (ledger: PaymentLedgerEntry[]): { ticketFeeDifferenceTotalCents: number; ticketFeeDifferenceCount: number } => {
  let total = 0;
  let count = 0;
  for (const entry of ledger) {
    if (entry.type !== 'TICKET_PAYMENT_SUCCEEDED' || entry.relatedType !== 'TicketOrder') continue;
    const difference = (entry.payload as { feeDifferenceCents?: unknown } | null)?.feeDifferenceCents;
    if (typeof difference !== 'number') continue;
    total += difference;
    count++;
  }
  return { ticketFeeDifferenceTotalCents: total, ticketFeeDifferenceCount: count };
};

const isCardVerificationRefund = async (
  refund: paystackClient.PaystackListedRefund,
  keys: { reference: string | null; transactionId: string | null }
): Promise<boolean> => {
  if (refund.transactionReference && (await paymentLedgerRepository.findCardVerification(refund.transactionReference, 'REFUND'))) return true;
  if (!cardVerificationRefundOf(refund.raw)) return false;
  return (await paymentAdjustmentRepository.findOriginal(keys, prisma)) === null;
};

// ─────────────────────────────────────────
//  DAILY RECONCILIATION (payments release 1)
//
//  For one UTC day, compares Paystack's own records with the ledger:
//   - every successful Paystack transaction must have a success row in the
//     ledger (matched by reference, else Paystack's transaction id), for the
//     same amount and currency: else PAYSTACK_ONLY / AMOUNT_DIFFERS /
//     CURRENCY_DIFFERS. A success recorded on another day (a payment made
//     just before midnight, confirmed after) still matches.
//   - every ledger success of that day must be a success at Paystack: one
//     missing from the day's list is checked with Paystack's verify before
//     it is called LEDGER_ONLY.
//   - every refund Paystack processed that day must have a REFUND_ISSUED
//     row: else REFUND_NOT_RECORDED.
//   - a card-update verification charge or its refund (the R1 Paystack
//     takes when a card is replaced) is neither: counted in the summary.
//   - a ticket order whose listed fee is above e-velope's whole charge is a
//     NEGATIVE_NET (a real loss); the day's fee differences (actual less
//     calculated, as recorded) are totalled in the summary.
//   - settlements that day are counted and totalled (the ledger holds no
//     fees, so they can't be matched one by one): in the run's summary.
//  Mismatches are PaymentMismatch rows (the super admin's list) and one
//  alert email per run. Nothing is corrected automatically.
// ─────────────────────────────────────────
export const paymentReconciliationService = {
  reconcileDay: async (runDate: string, options: { tenantIds?: string[] } = {}): Promise<ReconciliationResult> => {
    const from = new Date(`${runDate}T00:00:00.000Z`);
    const to = new Date(from.getTime() + DAY_MS);
    const mismatches: CreateMismatchInput[] = [];

    const transactions = (await paystackClient.listTransactions({ from: from.toISOString(), to: to.toISOString() }))
      .filter((t) => t.status === 'success');
    const ledger = await paymentLedgerRepository.findSuccessesBetween(from, to, options.tenantIds);

    // Successes Paystack has, looked up anywhere in the ledger (any day).
    const elsewhere = await paymentLedgerRepository.findByReferences(
      transactions.map((t) => t.reference),
      LEDGER_SUCCESS_TYPES
    );
    const byReference = new Map<string, PaymentLedgerEntry>();
    const byTransactionId = new Map<string, PaymentLedgerEntry>();
    for (const entry of [...ledger, ...elsewhere]) {
      if (entry.paystackReference && !byReference.has(entry.paystackReference)) byReference.set(entry.paystackReference, entry);
      if (entry.paystackTransactionId && !byTransactionId.has(entry.paystackTransactionId)) byTransactionId.set(entry.paystackTransactionId, entry);
    }

    // A card-update verification charge (the R1 Paystack takes and refunds
    // when a card is replaced): not a payment of ours, never PAYSTACK_ONLY.
    // Counted. Usually already "reversed" (refunded) by the time this runs,
    // so not in this success list at all.
    let cardVerificationCharges = 0;
    const isCardVerificationCharge = async (t: paystackClient.PaystackListedTransaction): Promise<boolean> =>
      cardVerificationChargeOf(t.raw) !== null || (await paymentLedgerRepository.findCardVerification(t.reference, 'CHARGE')) !== null;

    const matchedLedgerIds = new Set<string>();
    for (const t of transactions) {
      const entry = byReference.get(t.reference) ?? byTransactionId.get(t.id);
      if (!entry && (await isCardVerificationCharge(t))) {
        cardVerificationCharges++;
        continue;
      }
      if (!entry) {
        mismatches.push({
          source: 'RECONCILIATION',
          kind: 'PAYSTACK_ONLY',
          paystackReference: t.reference,
          paystackTransactionId: t.id,
          actualAmountCents: t.amountCents,
          currency: t.currency,
          details: { paidAt: t.paidAt },
        });
        continue;
      }
      matchedLedgerIds.add(entry.id);
      // A ticket order (ticket sales Round B): a real loss, Paystack's listed
      // fee above e-velope's whole transaction charge (fix/payments-go-live:
      // a fee that only eats into the commission, an international card, is
      // a fee difference, totalled in the summary, not a loss).
      if (entry.type === 'TICKET_PAYMENT_SUCCEEDED' && entry.relatedType === 'TicketOrder' && t.feesCents !== null) {
        const snapshot = (entry.payload ?? {}) as { transactionChargeCents?: unknown; commissionCents?: unknown };
        if (typeof snapshot.transactionChargeCents === 'number' && isTicketLoss(t.feesCents, snapshot.transactionChargeCents)) {
          mismatches.push({
            source: 'RECONCILIATION',
            kind: 'NEGATIVE_NET',
            paystackReference: t.reference,
            paystackTransactionId: t.id,
            tenantId: entry.tenantId,
            eventId: entry.eventId,
            expectedAmountCents: snapshot.transactionChargeCents,
            actualAmountCents: t.feesCents,
            currency: t.currency,
            details: {
              ledgerEntryId: entry.id,
              relatedId: entry.relatedId,
              lossCents: t.feesCents - snapshot.transactionChargeCents,
              transactionChargeCents: snapshot.transactionChargeCents,
              commissionCents: typeof snapshot.commissionCents === 'number' ? snapshot.commissionCents : null,
            },
          });
        }
      }
      if (entry.amountCents !== t.amountCents) {
        mismatches.push({
          source: 'RECONCILIATION',
          kind: 'AMOUNT_DIFFERS',
          paystackReference: t.reference,
          paystackTransactionId: t.id,
          tenantId: entry.tenantId,
          eventId: entry.eventId,
          expectedAmountCents: entry.amountCents,
          actualAmountCents: t.amountCents,
          currency: t.currency,
          details: { ledgerEntryId: entry.id, ledgerType: entry.type },
        });
      } else if (entry.currency.toUpperCase() !== t.currency.toUpperCase()) {
        mismatches.push({
          source: 'RECONCILIATION',
          kind: 'CURRENCY_DIFFERS',
          paystackReference: t.reference,
          paystackTransactionId: t.id,
          tenantId: entry.tenantId,
          eventId: entry.eventId,
          expectedAmountCents: entry.amountCents,
          actualAmountCents: t.amountCents,
          currency: t.currency,
          details: { ledgerEntryId: entry.id, ledgerCurrency: entry.currency },
        });
      }
    }

    for (const entry of ledger) {
      if (matchedLedgerIds.has(entry.id)) continue;
      let paystackStatus: string | null = null;
      if (entry.paystackReference) {
        try {
          const verified = await paystackClient.verifyTransaction(entry.paystackReference);
          paystackStatus = verified.status;
          if (verified.status === 'success') continue;
        } catch (err) {
          if (!(err instanceof PaystackApiError) || err.kind !== 'rejected') throw err;
          paystackStatus = 'not_found';
        }
      }
      mismatches.push({
        source: 'RECONCILIATION',
        kind: 'LEDGER_ONLY',
        paystackReference: entry.paystackReference,
        paystackTransactionId: entry.paystackTransactionId,
        tenantId: entry.tenantId,
        eventId: entry.eventId,
        expectedAmountCents: entry.amountCents,
        currency: entry.currency,
        details: { ledgerEntryId: entry.id, ledgerType: entry.type, paystackStatus },
      });
    }

    const refunds = (await paystackClient.listRefunds({ from: from.toISOString(), to: to.toISOString() }))
      .filter((r) => r.status === 'processed');
    let cardVerificationRefunds = 0;
    for (const refund of refunds) {
      const keys = { reference: refund.transactionReference, transactionId: refund.transactionId };
      const recorded = await paymentLedgerRepository.existsFor('REFUND_ISSUED', keys);
      // A card-update verification charge's refund: recorded as card
      // verification by its webhook, or (webhook missed) Paystack's own note
      // with no payment of ours refunded. Counted, never REFUND_NOT_RECORDED.
      if (!recorded && (await isCardVerificationRefund(refund, keys))) {
        cardVerificationRefunds++;
        continue;
      }
      if (!recorded) {
        mismatches.push({
          source: 'RECONCILIATION',
          kind: 'REFUND_NOT_RECORDED',
          paystackReference: refund.transactionReference,
          paystackTransactionId: refund.transactionId,
          actualAmountCents: refund.amountCents,
          currency: refund.currency,
          details: { refundId: refund.id },
        });
      }
    }

    let settlementCount = 0;
    let settledTotalCents = 0;
    try {
      const settlements = await paystackClient.listSettlements({ from: from.toISOString(), to: to.toISOString() });
      settlementCount = settlements.length;
      settledTotalCents = settlements.reduce((sum, s) => sum + s.totalAmountCents, 0);
    } catch (err) {
      // Settlements are informational; a failure here never fails the run.
      console.error('[reconciliation] could not list settlements:', err);
      settlementCount = -1;
    }

    return {
      runDate,
      paystackSuccessCount: transactions.length,
      ledgerSuccessCount: ledger.length,
      refundCount: refunds.length,
      settlementCount,
      settledTotalCents,
      ...ticketFeeDifferences(ledger),
      cardVerificationChargeCount: cardVerificationCharges,
      cardVerificationRefundCount: cardVerificationRefunds,
      mismatches,
    };
  },

  // The daily run for one day, once across every server instance (the
  // run's unique runDate is the claim). Mismatches are saved against the
  // run and summarised in one alert. null when the day was already run.
  runForDate: async (runDate: string, options: { tenantIds?: string[] } = {}) => {
    const run = await paymentReconciliationRepository.claimRun(runDate);
    if (!run) return null;
    try {
      const result = await paymentReconciliationService.reconcileDay(runDate, options);
      for (const mismatch of result.mismatches) {
        await paymentReconciliationRepository.createMismatch({ ...mismatch, runId: run.id });
      }
      const { mismatches, ...counts } = result;
      await paymentReconciliationRepository.finishRun(run.id, { status: 'DONE', mismatchCount: mismatches.length, summary: counts });
      if (mismatches.length > 0) {
        await paymentAlertService.send({
          kind: 'RECONCILIATION',
          subject: `Reconciliation for ${runDate}: ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}`,
          lines: ["The ledger and Paystack's records don't agree for this day. Each mismatch is listed in the payments screen."],
          facts: mismatches.slice(0, 20).map((m) =>
            `${m.kind}: ${m.paystackReference ?? m.paystackTransactionId ?? 'no reference'}` +
            (m.actualAmountCents !== undefined && m.actualAmountCents !== null ? ` (${formatRand(m.actualAmountCents, m.currency ?? 'ZAR')})` : '')
          ),
        });
      }
      return result;
    } catch (err) {
      console.error(`[reconciliation] the run for ${runDate} failed:`, err);
      reportError(err);
      await paymentReconciliationRepository.finishRun(run.id, {
        status: 'FAILED',
        mismatchCount: 0,
        summary: { error: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
  },

  // ── Super admin views ──

  listLedger: async (filter: {
    tenantId?: string;
    eventId?: string;
    types?: LedgerEntryType[];
    reference?: string;
    from?: Date;
    to?: Date;
    cursor?: string;
    limit: number;
  }): Promise<Page<LedgerEntryDto>> => {
    const rows = await paymentLedgerRepository.list(filter);
    const items = rows.slice(0, filter.limit).map((r) => ({
      id: r.id,
      type: r.type,
      amountCents: r.amountCents,
      currency: r.currency,
      tenantId: r.tenantId,
      eventId: r.eventId,
      paystackReference: r.paystackReference,
      paystackTransactionId: r.paystackTransactionId,
      relatedType: r.relatedType,
      relatedId: r.relatedId,
      payload: r.payload,
      occurredAt: r.occurredAt,
      createdAt: r.createdAt,
    }));
    return { items, nextCursor: rows.length > filter.limit ? (items[items.length - 1]?.id ?? null) : null };
  },

  listMismatches: async (filter: { status: 'open' | 'resolved' | 'all'; cursor?: string; limit: number }): Promise<Page<MismatchDto>> => {
    const rows = await paymentReconciliationRepository.listMismatches(filter);
    const items = rows.slice(0, filter.limit).map((m) => ({
      id: m.id,
      source: m.source,
      kind: m.kind,
      paystackReference: m.paystackReference,
      paystackTransactionId: m.paystackTransactionId,
      tenantId: m.tenantId,
      eventId: m.eventId,
      expectedAmountCents: m.expectedAmountCents,
      actualAmountCents: m.actualAmountCents,
      currency: m.currency,
      details: m.details,
      runDate: m.run?.runDate ?? null,
      createdAt: m.createdAt,
      resolvedAt: m.resolvedAt,
    }));
    return { items, nextCursor: rows.length > filter.limit ? (items[items.length - 1]?.id ?? null) : null };
  },

  listRuns: async (limit: number): Promise<ReconciliationRunDto[]> =>
    (await paymentReconciliationRepository.listRuns(limit)).map((r) => ({
      id: r.id,
      runDate: r.runDate,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      mismatchCount: r.mismatchCount,
      summary: r.summary,
    })),
};
