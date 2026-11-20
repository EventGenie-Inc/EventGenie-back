import { type Prisma } from '@prisma/client';

// ─────────────────────────────────────────
//  PENDING CHECKOUTS (payments release 1)
//
//  A second purchase of the same thing while one is pending reuses the same
//  Paystack checkout instead of starting another: two live checkouts for one
//  purchase can both be paid (two charges), and two subscribe checkouts can
//  become two Paystack subscriptions. For a different choice while one is
//  pending (another pass tier, another SMS count, another plan) the answer
//  is 409 PAYMENT_ALREADY_PENDING until the window passes.
//
//  REUSE window: 30 minutes, the life of a ticket's hold and long enough for
//  a card's 3-D Secure step or an EFT bank login. After it, a new checkout
//  may be started; the old one, if it is still paid later, is still matched
//  by its own reference (and an Event Pass can only ever raise the event's
//  tier).
//
//  STALE: a pending attempt older than 24 hours is checked with Paystack by
//  the hourly sweep (payment-maintenance.service.ts): paid is confirmed,
//  anything else is FAILED (or, for a subscribe attempt, cleared). A FAILED
//  attempt that Paystack later reports paid is still granted (FAILED → PAID).
// ─────────────────────────────────────────
export const PENDING_CHECKOUT_REUSE_MS = 30 * 60 * 1000;
export const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

// One purchase decision at a time per scope (an event's pass, an event's
// SMS bundles, a tenant's subscription): the check for a pending attempt and
// the insert of a new one can't interleave between two requests. Same
// transaction-scoped advisory lock as event.repository.ts's event-creation
// lock ($executeRaw: pg_advisory_xact_lock returns void).
export const lockPaymentScope = async (tx: Prisma.TransactionClient, scope: string): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${scope}`}, 0))`;
};

export const reuseCutoff = (now: Date = new Date()): Date => new Date(now.getTime() - PENDING_CHECKOUT_REUSE_MS);
// When a different choice may be started, for a pending attempt started at
// `startedAt` (409 PAYMENT_ALREADY_PENDING's details).
export const reuseEndsAt = (startedAt: Date | null): Date | null =>
  startedAt ? new Date(startedAt.getTime() + PENDING_CHECKOUT_REUSE_MS) : null;
export const staleCutoff =(now: Date = new Date()): Date => new Date(now.getTime() - STALE_PENDING_MS);
