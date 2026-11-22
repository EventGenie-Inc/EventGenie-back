import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { paymentAccountService } from './payment-account.service.js';

// ─────────────────────────────────────────
//  PAYOUT ACCOUNT WORKER (ticket sales Round A)
//
//  Every 5 minutes (started by server.ts only; tests call runOnce scoped to
//  their own tenants): confirms subaccounts whose creation got no clear
//  answer, then switches every confirmed change whose 24 hours are up.
//  Each switch is claimed by the change's own PENDING → APPLIED write, so
//  two servers never both apply one. Paystack failing leaves the current
//  account in use, and the next run tries again.
//
//  Behind `ticketing`, like the payout routes: off, nothing is switched
//  (the changes wait, and go through once it is back on).
// ─────────────────────────────────────────

export const PAYOUT_WORKER_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

export const payoutAccountWorker = {
  runOnce: async ({ now = new Date(), tenantIds }: { now?: Date; tenantIds?: string[] } = {}): Promise<{ confirmed: number; applied: number }> => {
    if (!isFeatureEnabled('ticketing')) return { confirmed: 0, applied: 0 };
    const confirmed = await paymentAccountService.confirmPending(now, tenantIds);
    const applied = await paymentAccountService.applyDue(now, tenantIds);
    return { confirmed, applied };
  },
};

export const startPayoutAccountWorker = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await payoutAccountWorker.runOnce();
    } catch (err) {
      console.error('[payment-account] worker run failed:', err);
      reportError(err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), FIRST_RUN_DELAY_MS);
  const interval = setInterval(() => void run(), PAYOUT_WORKER_INTERVAL_MS);
  first.unref();
  interval.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
};
