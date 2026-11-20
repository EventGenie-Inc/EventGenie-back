import { type Prisma } from '@prisma/client';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { PaystackApiError } from '../../shared/payments/paystack.client.js';
import { staleCutoff } from '../../shared/payments/pending-checkout.util.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { eventPassRepository } from '../event-pass/event-pass.repository.js';
import { eventPassService } from '../event-pass/event-pass.service.js';
import { subscriptionRepository } from '../subscription/subscription.repository.js';
import { subscriptionService } from '../subscription/subscription.service.js';
import { subscriptionSyncService } from '../subscription/subscription-sync.service.js';
import { withPaymentContext } from '../payment-webhook/payment-context.util.js';
import { paymentReconciliationService, utcDay } from './payment-reconciliation.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PAYMENT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

type Verdict = 'paid' | 'not_paid' | 'unavailable';

// Paystack's verdict on one reference: paid, definitely not paid (failed,
// abandoned, or a reference it doesn't know), or no answer now.
const verdictFor = async (reference: string): Promise<{ verdict: Verdict; raw?: Record<string, unknown>; status?: string }> => {
  try {
    const verified = await paystackClient.verifyTransaction(reference);
    if (verified.status === 'success') return { verdict: 'paid', raw: verified.raw, status: verified.status };
    // "ongoing", "pending", "processing", "queued": not settled yet.
    if (['failed', 'abandoned', 'reversed'].includes(verified.status)) return { verdict: 'not_paid', status: verified.status };
    return { verdict: 'unavailable', status: verified.status };
  } catch (err) {
    if (err instanceof PaystackApiError && err.kind === 'rejected') return { verdict: 'not_paid', status: 'not_found' };
    return { verdict: 'unavailable' };
  }
};

// ─────────────────────────────────────────
//  PAYMENT MAINTENANCE (payments release 1)
//
//  Hourly: the stale sweep (pending purchases and subscribe attempts older
//  than a day, each checked with Paystack: paid → confirmed through the same
//  path as the webhook, definitely not paid → FAILED / cleared, no answer →
//  left for next hour) and the sync of flagged tenants.
//  Daily (the first hourly run of a UTC day): the reconciliation of the day
//  before (claimed once across instances) and the sync of every tenant
//  with a subscription.
//  Started by server.ts only; tests call runHourly / runDaily scoped to
//  their own tenants.
// ─────────────────────────────────────────
export const paymentMaintenanceService = {
  sweepStalePending: async (options: { now?: Date; tenantIds?: string[] } = {}): Promise<{ confirmed: number; failed: number; skipped: number }> => {
    const before = staleCutoff(options.now ?? new Date());
    let confirmed = 0;
    let failed = 0;
    let skipped = 0;

    for (const purchase of await eventPassRepository.findStalePendingPurchases(before, options.tenantIds)) {
      if (!purchase.paymentRef) continue;
      const { verdict, raw, status } = await verdictFor(purchase.paymentRef);
      if (verdict === 'paid' && raw) {
        await withPaymentContext('sweep', raw, (ctx) => eventPassService.confirmPassPurchaseWithinTransaction(ctx, purchase.paymentRef!));
        confirmed++;
      } else if (verdict === 'not_paid') {
        const result = await eventPassRepository.markPurchaseFailed(purchase.paymentRef);
        if (result.count === 1) {
          await paymentLedgerService.record({
            type: 'EVENT_PASS_PURCHASE_FAILED',
            amountCents: purchase.amountPaidCents,
            currency: purchase.currency,
            tenantId: purchase.tenantId,
            eventId: purchase.eventId,
            paystackReference: purchase.paymentRef,
            relatedType: 'EventPassPurchase',
            relatedId: purchase.id,
            payload: { stage: 'expired', paystackStatus: status ?? null } as unknown as Prisma.InputJsonValue,
          });
        }
        failed++;
      } else {
        skipped++;
      }
    }

    for (const purchase of await eventPassRepository.findStalePendingSmsBundlePurchases(before, options.tenantIds)) {
      if (!purchase.paymentRef) continue;
      const { verdict, raw, status } = await verdictFor(purchase.paymentRef);
      if (verdict === 'paid' && raw) {
        await withPaymentContext('sweep', raw, (ctx) => eventPassService.confirmSmsBundlePurchaseWithinTransaction(ctx, purchase.paymentRef!));
        confirmed++;
      } else if (verdict === 'not_paid') {
        const result = await eventPassRepository.markSmsBundlePurchaseFailed(purchase.paymentRef);
        if (result.count === 1) {
          await paymentLedgerService.record({
            type: 'SMS_BUNDLE_PURCHASE_FAILED',
            amountCents: purchase.amountPaidCents,
            currency: purchase.currency,
            tenantId: purchase.tenantId,
            eventId: purchase.eventId,
            paystackReference: purchase.paymentRef,
            relatedType: 'EventSmsBundlePurchase',
            relatedId: purchase.id,
            payload: { stage: 'expired', paystackStatus: status ?? null } as unknown as Prisma.InputJsonValue,
          });
        }
        failed++;
      } else {
        skipped++;
      }
    }

    // A subscribe attempt has no row of its own: a paid one is recorded and
    // its subscription adopted; anything else is simply cleared (it would
    // only read as a failure in the tenant's history). A plan change's marker
    // is the sync's to clear.
    for (const tenant of await subscriptionRepository.findStalePendingAttempts(before, options.tenantIds)) {
      const reference = tenant.subscriptionPendingReference;
      if (!reference || reference.startsWith('upg_')) continue;
      try {
        const outcome = await subscriptionService.checkPendingCheckout(tenant, reference);
        if (outcome === 'paid') {
          confirmed++;
        } else {
          await subscriptionRepository.clearPendingAttempt(tenant.id, undefined, reference);
          failed++;
        }
      } catch {
        skipped++;
      }
    }

    return { confirmed, failed, skipped };
  },

  runHourly: async (options: { now?: Date; tenantIds?: string[] } = {}) => {
    const sweep = await paymentMaintenanceService.sweepStalePending(options);
    const sync = await subscriptionSyncService.syncMany({ onlyFlagged: true, ...options });
    return { sweep, sync };
  },

  // Yesterday (UTC), once: runForDate's claim makes every later call that
  // day a no-op, on this instance or another.
  runDaily: async (options: { now?: Date; tenantIds?: string[] } = {}) => {
    const now = options.now ?? new Date();
    const runDate = utcDay(new Date(now.getTime() - DAY_MS));
    const reconciliation = await paymentReconciliationService.runForDate(runDate, { ...(options.tenantIds && { tenantIds: options.tenantIds }) });
    // The full sync only on the run that did the reconciliation: once a day.
    const sync = reconciliation ? await subscriptionSyncService.syncMany({ onlyFlagged: false, ...options }) : null;
    return { runDate, reconciliation, sync };
  },
};

export const startPaymentMaintenance = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await paymentMaintenanceService.runHourly();
      await paymentMaintenanceService.runDaily();
    } catch (err) {
      console.error('[payments] maintenance run failed:', err);
      reportError(err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), PAYMENT_MAINTENANCE_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
