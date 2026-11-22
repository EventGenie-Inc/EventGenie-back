import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { ticketOrderConfirmService } from './ticket-order-confirm.service.js';

// ─────────────────────────────────────────
//  TICKET ORDER WORKER (ticket sales Round B)
//
//  Every minute (started by server.ts only; tests call runOnce scoped to
//  their own events): orders still unpaid when their 30-minute hold ran out
//  give their stock back (PENDING → EXPIRED), and confirmation emails that
//  didn't go out (a failed send, a crash) are sent. Each order is changed
//  under its own row lock, so two servers never both release one.
// ─────────────────────────────────────────

export const TICKET_ORDER_WORKER_INTERVAL_MS = 60 * 1000;

export const ticketOrderWorker = {
  runOnce: async ({ now = new Date(), eventIds }: { now?: Date; eventIds?: string[] } = {}): Promise<{ expired: number; emailed: number }> => {
    if (!isFeatureEnabled('ticketing')) return { expired: 0, emailed: 0 };
    const expired = await ticketOrderConfirmService.expireDue(now, eventIds);
    const emailed = await ticketOrderConfirmService.sendPendingConfirmations(now, eventIds);
    return { expired, emailed };
  },
};

export const startTicketOrderWorker = (): (() => void) => {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await ticketOrderWorker.runOnce();
    } catch (err) {
      console.error('[ticket-order] worker run failed:', err);
      reportError(err);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void run(), TICKET_ORDER_WORKER_INTERVAL_MS);
  interval.unref();
  return () => clearInterval(interval);
};
