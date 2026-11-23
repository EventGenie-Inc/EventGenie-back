import crypto from 'crypto';
import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import * as paystackClient from '../../shared/payments/paystack.client.js';
import { describePaystackFailure, PaystackApiError } from '../../shared/payments/paystack.client.js';
import { lockPaymentScope } from '../../shared/payments/pending-checkout.util.js';
import { checkoutCancelUrl } from '../../shared/payments/checkout-cancel.util.js';
import { PAYMENT_PROVIDER_UNAVAILABLE, PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE } from '../../shared/payments/payment-errors.util.js';
import { normalizeEmail, isValidEmail } from '../../shared/utils/email.util.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { normalizePhoneToE164, resolvePhoneCountry } from '../guest/guest-validation.util.js';
import { eventRepository } from '../event/event.repository.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { lastDayEndsAt } from '../ticket/ticket-validation.util.js';
import { assertOrderDaysHaveRoom, lockOrderDays, type AdmittingLine } from '../ticket/ticket-day-capacity.util.js';
import { paymentAccountRepository } from '../payment-account/payment-account.repository.js';
import { paymentLedgerService } from '../payment-ledger/payment-ledger.service.js';
import { calculateTicketOrderFees } from '../ticket-sales/ticket-fee-calculator.js';
import { TERMS_VERSION } from '../terms/terms.service.js';
import { buildOrderToken, verifyOrderToken } from '../check-in-pass/check-in-pass-token.util.js';
import { PAYMENT_TRANSACTION_OPTIONS, withPaymentContext } from '../payment-webhook/payment-context.util.js';
import { ticketOrderRepository, type OrderRow } from './ticket-order.repository.js';
import { toOrderView, publicShareTokenOf, type EventForView } from './ticket-order-view.js';
import { ticketOrderConfirmService } from './ticket-order-confirm.service.js';
import {
  MAX_TICKETS_PER_ORDER,
  ORDER_HOLD_MINUTES,
  TICKET_ORDER_CODES as CODES,
  type CheckoutInput,
  type CheckoutResult,
  type OrderView,
} from './ticket-order.types.js';

// ─────────────────────────────────────────
//  CHECKOUT (ticket sales Round B; STEERING "Ticket sales")
//
//  Public, no sign-in: a guest buys tickets for a paid public event from
//  its share link. In order:
//   1. The request is checked, then the event and each ticket type, with
//      every refusal in the buyer's words and its own code. Sales windows
//      and the event's end are South African time (Round A); the end is
//      re-checked here, even if the event's days moved after a type was
//      saved. The plan is never re-checked: a paid event keeps selling
//      after a downgrade.
//   2. Under an advisory lock per event and buyer: the same idempotency key,
//      or the same buyer, event and items while still pending and held,
//      gets the same checkout back, never a second hold or charge.
//   3. Stock is held for 30 minutes, one conditional UPDATE per type
//      (sold + held + quantity ≤ quantity): of two buyers racing for the
//      last ticket, one gets it and one is refused. Then each day the
//      order's tickets admit, if it has a capacity: sold + held + attending
//      guests + this order's tickets admitting it must fit
//      (ticket-day-capacity.util.ts: the days are locked before the holds
//      and counted under that lock; 409 TICKET_ORDER_DAY_FULL).
//   4. The order is written PENDING with everything snapshotted: items and
//      unit prices, the fee calculator's breakdown for the whole order, the
//      live payout subaccount, the Terms version.
//   5. Paystack is initialised: our reference, metadata { orderId, kind },
//      split at source (subaccount, transaction_charge = e-velope's charge,
//      bearer account), channels that can't cost more than a local card.
//  Nothing is ever "paid" here: only the webhook or a verify confirms.
// ─────────────────────────────────────────

const HOLD_MS = ORDER_HOLD_MINUTES * 60_000;
const MAX_NAME_LENGTH = 100;

// Channels whose Paystack fee is never above the local card fee the price
// is grossed up for: cards (local 2.9% + R1; international cards travel on
// the same channel at 3.1% + R1, which can't be excluded per payment: see
// the negative-net alert), EFT and Capitec Pay (2%, no flat fee). Paystack
// Scan to Pay and Apple Pay are left out: their fee isn't confirmed to be
// at or below a local card's. PAYSTACK_TICKET_CHANNELS overrides it.
export const DEFAULT_TICKET_CHANNELS = ['card', 'eft', 'capitec_pay'];
export const ticketChannels = (): string[] => {
  const configured = process.env['PAYSTACK_TICKET_CHANNELS']?.split(',').map((c) => c.trim()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_TICKET_CHANNELS;
};

export const TICKET_ORDER_REFERENCE_PREFIX = 'tko_';
const newReference = (): string => `${TICKET_ORDER_REFERENCE_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

const invalid = (message = 'Something went wrong with your order. Please refresh the page and try again.') =>
  new HttpError(400, message, CODES.REQUEST_INVALID);

const formatRand = (cents: number): string => `R${(cents / 100).toFixed(2)}`;

interface ParsedCheckout {
  shareToken: string;
  items: { ticketTypeId: string; quantity: number }[];
  buyer: { name: string; email: string; phone: string | null };
  idempotencyKey: string;
}

const parseCheckout = (input: CheckoutInput): ParsedCheckout => {
  if (!input || typeof input !== 'object') throw invalid();
  if (typeof input.shareToken !== 'string' || !input.shareToken.trim()) throw invalid();
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(input.idempotencyKey)) throw invalid();
  if (!Array.isArray(input.items) || input.items.length === 0) throw invalid('Choose at least one ticket.');

  const merged = new Map<string, number>();
  for (const raw of input.items as unknown[]) {
    const item = raw as { ticketTypeId?: unknown; quantity?: unknown };
    if (typeof item?.ticketTypeId !== 'string' || !item.ticketTypeId) throw invalid();
    if (typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new HttpError(422, 'Choose how many tickets you want: a whole number of 1 or more.', CODES.REQUEST_INVALID);
    }
    if (merged.has(item.ticketTypeId)) throw invalid();
    merged.set(item.ticketTypeId, item.quantity);
  }
  const total = [...merged.values()].reduce((a, b) => a + b, 0);
  if (total > MAX_TICKETS_PER_ORDER) {
    throw new HttpError(422, `One order can have at most ${MAX_TICKETS_PER_ORDER} tickets.`, CODES.TOO_MANY_TICKETS);
  }

  const buyer = (input.buyer ?? {}) as { name?: unknown; email?: unknown; phone?: unknown; phoneCountry?: unknown };
  if (typeof buyer !== 'object') throw invalid();
  const name = typeof buyer.name === 'string' ? buyer.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new HttpError(422, 'Enter your name.', CODES.BUYER_NAME_REQUIRED);
  if (name.length > MAX_NAME_LENGTH) throw new HttpError(422, `Your name can be at most ${MAX_NAME_LENGTH} characters.`, CODES.BUYER_NAME_REQUIRED);
  const email = typeof buyer.email === 'string' ? normalizeEmail(buyer.email) : '';
  if (!email || !isValidEmail(email)) {
    throw new HttpError(422, 'Enter a valid email address: your tickets are sent there.', CODES.BUYER_EMAIL_INVALID);
  }
  let phone: string | null = null;
  if (typeof buyer.phone === 'string' && buyer.phone.trim()) {
    try {
      phone = normalizePhoneToE164(buyer.phone.trim(), resolvePhoneCountry(buyer.phoneCountry));
    } catch (err) {
      // The contact codes, as at registration: a wrong number is a value to fix.
      if (err instanceof HttpError && err.statusCode === 400) throw new HttpError(422, err.message, err.code);
      throw err;
    }
  } else if (buyer.phone !== undefined && buyer.phone !== null && buyer.phone !== '') {
    throw invalid();
  }

  if (input.termsAccepted !== true) {
    throw new HttpError(422, 'Accept the Terms of Service to buy tickets.', CODES.TERMS_REQUIRED);
  }

  return {
    shareToken: input.shareToken.trim(),
    items: [...merged.entries()].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })),
    buyer: { name, email, phone },
    idempotencyKey: input.idempotencyKey,
  };
};

const fingerprintOf = (eventId: string, email: string, items: { ticketTypeId: string; quantity: number }[]): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([eventId, email, [...items].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId)).map((i) => [i.ticketTypeId, i.quantity])]))
    .digest('hex');

// The event a share link names, for selling: refused unless paid, public,
// published, live and not paused.
const findSellingEvent = async (shareToken: string, now: Date) => {
  const event = await eventRepository.findByShareToken(shareToken);
  if (!event || event.visibility !== 'PUBLIC' || event.isArchived) {
    throw new HttpError(404, "This event link isn't valid. Check the link, or ask the organiser for a new one.", CODES.EVENT_NOT_FOUND);
  }
  const status = resolveEffectiveStatus(event);
  if (status === 'CANCELLED') throw new HttpError(410, 'This event has been cancelled.', CODES.EVENT_CANCELLED);
  if (!isFeatureEnabled('ticketing') || event.ticketing !== 'PAID' || status === 'DRAFT') {
    throw new HttpError(409, "Tickets for this event aren't on sale.", CODES.NOT_ON_SALE);
  }
  const ends = lastDayEndsAt(event.eventDays);
  if (status === 'COMPLETED' || (ends && ends <= now)) {
    throw new HttpError(410, 'This event has already taken place, so tickets are no longer on sale.', CODES.EVENT_ENDED);
  }
  if (event.salesPaused) {
    throw new HttpError(409, "Ticket sales for this event are paused. Please try again later.", CODES.SALES_PAUSED);
  }
  return event;
};


const viewOf = (
  order: OrderRow,
  event: Omit<EventForView, 'shareToken'> & { shareToken: string | null; visibility: string; isArchived: boolean }
): OrderView =>
  toOrderView(order, { name: event.name, hostName: event.hostName, shareToken: publicShareTokenOf(event), eventDays: event.eventDays });

// Paystack for one attempt: the split, our reference, the channels. Never
// throws: a failure is the caller's to record.
const initialise = async (order: OrderRow, reference: string): Promise<{ ok: true; url: string } | { ok: false; error: unknown }> => {
  const callbackUrl = frontendUrl('/tickets/checkout/callback');
  try {
    const result = await paystackClient.initializeTransaction({
      email: order.buyerEmail,
      amountCents: order.totalCents,
      currency: order.currency,
      reference,
      callbackUrl,
      channels: ticketChannels(),
      subaccount: order.subaccountCode,
      transactionChargeCents: order.transactionChargeCents,
      bearer: 'account',
      metadata: { orderId: order.id, kind: 'TICKET_ORDER', cancel_action: checkoutCancelUrl(callbackUrl, reference) },
    });
    return { ok: true, url: result.authorizationUrl };
  } catch (error) {
    return { ok: false, error };
  }
};

// An attempt that couldn't start: nobody can pay that reference without its
// link, so the order is FAILED and its hold given back (a late success on it
// is still honoured, confirm service). The buyer sees the neutral words.
const startFailed = async (order: OrderRow, reference: string, error: unknown): Promise<never> => {
  const failure = describePaystackFailure(error);
  console.error(`[ticket-order] checkout start failed for order ${order.id}: ${failure.kind}`);
  await prisma.$transaction(async (tx) => {
    await ticketOrderRepository.lock(tx, order.id);
    await tx.ticketOrderPayment.updateMany({ where: { reference, status: 'INITIATED' }, data: { status: 'FAILED' } });
    const fresh = await tx.ticketOrder.findUnique({ where: { id: order.id } });
    if (fresh?.status === 'PENDING') {
      await tx.ticketOrder.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      await ticketOrderConfirmService.releaseHoldWithinTransaction(tx, order.id);
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
        payload: { stage: 'initialize', kind: failure.kind, summary: failure.summary, raw: failure.raw } as unknown as Prisma.InputJsonValue,
      },
      tx
    );
  }, PAYMENT_TRANSACTION_OPTIONS);
  throw failure.kind === 'rejected'
    ? new HttpError(422, "We couldn't start this payment. Nothing was charged. Please try again.", 'PAYMENT_REJECTED')
    : new HttpError(503, PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
};

export const ticketOrderService = {
  checkout: async (input: CheckoutInput, now: Date = new Date()): Promise<CheckoutResult> => {
    const req = parseCheckout(input);
    const event = await findSellingEvent(req.shareToken, now);

    // Each type: this event's, ACTIVE, within its window (SA time), within
    // its maxPerOrder. Every refusal names the type.
    const types = await prisma.ticket.findMany({
      where: { id: { in: req.items.map((i) => i.ticketTypeId) }, eventId: event.id, isArchived: false },
      include: { admittedDays: { select: { eventDayId: true } } },
    });
    for (const item of req.items) {
      const type = types.find((t) => t.id === item.ticketTypeId);
      if (!type || type.status !== 'ACTIVE') {
        throw new HttpError(409, "One of the tickets you chose isn't available any more. Please refresh the page and choose again.", CODES.TYPE_UNAVAILABLE);
      }
      if (type.salesStart && type.salesStart > now) {
        throw new HttpError(409, `'${type.name}' tickets aren't on sale yet.`, CODES.TYPE_NOT_YET_ON_SALE);
      }
      if (type.salesEnd && type.salesEnd <= now) {
        throw new HttpError(409, `Sales of '${type.name}' tickets have ended.`, CODES.TYPE_SALES_ENDED);
      }
      if (item.quantity > type.maxPerOrder) {
        throw new HttpError(422, `You can buy at most ${type.maxPerOrder} '${type.name}' tickets in one order.`, CODES.TOO_MANY_OF_TYPE);
      }
    }

    // Somewhere for the money to land: the live payout account, never the
    // plan (a paid event keeps selling after a downgrade).
    const tenant = await paymentAccountRepository.findStatusByTenantId(event.tenantId);
    if (!tenant?.paystackSubaccountCode || tenant.paystackSubaccountStatus !== 'ACTIVE') {
      throw new HttpError(409, "This event can't take payments right now. Please try again later.", CODES.PAYMENTS_UNAVAILABLE);
    }
    const subaccountCode = tenant.paystackSubaccountCode;

    const lines = req.items.map((item) => {
      const type = types.find((t) => t.id === item.ticketTypeId)!;
      return { item, type };
    });
    // The whole order through the one calculator: a weighted unit price
    // isn't needed, the subtotal is what the order costs.
    const subtotal = lines.reduce((sum, l) => sum + l.type.priceCents * l.item.quantity, 0);
    const fees = calculateTicketOrderFees({ unitPriceCents: subtotal, quantity: 1 });
    const fingerprint = fingerprintOf(event.id, req.buyer.email, req.items);
    const reference = newReference();
    const liveDayIds = event.eventDays.map((d) => d.id);
    const admitting: AdmittingLine[] = lines.map(({ item, type }) => ({
      admitsAllDays: type.admitsAllDays,
      admittedDayIds: type.admittedDays.map((d) => d.eventDayId),
      quantity: item.quantity,
    }));

    const claim = await prisma.$transaction(async (tx) => {
      await lockPaymentScope(tx, `ticket-checkout:${event.id}:${crypto.createHash('sha256').update(req.buyer.email).digest('hex')}`);
      const byKey = await ticketOrderRepository.findByIdempotencyKey(event.id, req.idempotencyKey, tx);
      if (byKey) return { kind: 'existing' as const, order: byKey, viaKey: true };
      const byFingerprint = await ticketOrderRepository.findPendingByFingerprint(fingerprint, now, tx);
      if (byFingerprint) return { kind: 'existing' as const, order: byFingerprint, viaKey: false };

      // The days first (every hold against a day takes this lock), then each
      // type's own quantity, then the days' capacity under the lock.
      const lockedDays = await lockOrderDays(tx, admitting, liveDayIds);
      for (const { item, type } of lines) {
        if (!(await ticketOrderRepository.hold(tx, type.id, item.quantity))) {
          const left = await tx.ticket.findUnique({ where: { id: type.id }, select: { soldCount: true, heldCount: true, totalQuantity: true } });
          const remaining = left?.totalQuantity === null || !left ? 0 : Math.max(0, left.totalQuantity - left.soldCount - left.heldCount);
          throw new HttpError(
            409,
            remaining === 0
              ? `'${type.name}' tickets are sold out.`
              : `Only ${remaining} '${type.name}' ${remaining === 1 ? 'ticket is' : 'tickets are'} left.`,
            CODES.NOT_ENOUGH_LEFT,
            { ticketTypeId: type.id, remaining }
          );
        }
      }
      await assertOrderDaysHaveRoom(tx, lockedDays, admitting, liveDayIds, now);

      const order = await tx.ticketOrder.create({
        data: {
          eventId: event.id,
          tenantId: event.tenantId,
          buyerName: req.buyer.name,
          buyerEmail: req.buyer.email,
          buyerPhone: req.buyer.phone,
          idempotencyKey: req.idempotencyKey,
          requestFingerprint: fingerprint,
          subtotalCents: fees.subtotalCents,
          commissionCents: fees.commissionCents,
          platformFixedFeeCents: fees.platformFixedFeeCents,
          processingFeeCents: fees.processingFeeCents,
          totalCents: fees.totalCents,
          transactionChargeCents: fees.transactionChargeCents,
          subaccountCode,
          termsVersion: TERMS_VERSION,
          holdExpiresAt: new Date(now.getTime() + HOLD_MS),
          items: {
            create: lines.map(({ item, type }) => ({
              ticketTypeId: type.id,
              typeName: type.name,
              quantity: item.quantity,
              unitPriceCents: type.priceCents,
              admitsAllDays: type.admitsAllDays,
              admittedDayIds: type.admittedDays.map((d) => d.eventDayId),
            })),
          },
          payments: { create: { reference } },
        },
        include: { items: true, payments: true, tickets: { include: { checkIns: true } } },
      });
      await paymentLedgerService.record(
        {
          type: 'TICKET_PAYMENT_INITIATED',
          amountCents: fees.totalCents,
          currency: 'ZAR',
          tenantId: event.tenantId,
          eventId: event.id,
          paystackReference: reference,
          relatedType: 'TicketOrder',
          relatedId: order.id,
          payload: { items: req.items, ...fees, subaccountCode, termsVersion: TERMS_VERSION } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
      return { kind: 'new' as const, order: order as OrderRow };
    }, PAYMENT_TRANSACTION_OPTIONS);

    if (claim.kind === 'existing') {
      const { order, viaKey } = claim;
      const latest = order.payments[order.payments.length - 1];
      if (order.status === 'PENDING' && !latest?.authorizationUrl) {
        throw new HttpError(409, 'This order is still being set up. Please wait a moment and try again.', CODES.IN_PROGRESS);
      }
      // The client's own key: its token too. The same buyer and items by
      // another request: the checkout, but not the token (the tickets are
      // emailed to the buyer either way).
      return { ...viewOf(order, event), orderToken: viaKey ? buildOrderToken(order.id) : null, reused: true };
    }

    const started = await initialise(claim.order, reference);
    if (!started.ok) return startFailed(claim.order, reference, started.error);
    await prisma.ticketOrderPayment.update({ where: { reference }, data: { authorizationUrl: started.url } });
    const order = (await ticketOrderRepository.findById(claim.order.id))!;
    return { ...viewOf(order, event), orderToken: buildOrderToken(order.id), reused: false };
  },

  // POST /api/ticket-orders/status { token, refresh? }. With refresh (the
  // callback page, once the payer is back), a PENDING or FAILED order is
  // verified with Paystack: success confirms it (the same path as the
  // webhook), failed or abandoned records the failure. Never "paid" otherwise.
  status: async (token: unknown, refresh: unknown): Promise<OrderView> => {
    const order = await findByToken(token);
    if (refresh === true && (order.status === 'PENDING' || order.status === 'FAILED' || order.status === 'EXPIRED')) {
      for (const payment of [...order.payments].reverse()) {
        if (payment.status !== 'INITIATED' && payment.status !== 'FAILED') continue;
        let verified: Awaited<ReturnType<typeof paystackClient.verifyTransaction>>;
        try {
          verified = await paystackClient.verifyTransaction(payment.reference);
        } catch (err) {
          if (err instanceof PaystackApiError && err.kind === 'rejected') continue; // never reached Paystack's books
          throw new HttpError(503, PAYMENT_PROVIDER_UNAVAILABLE_MESSAGE, PAYMENT_PROVIDER_UNAVAILABLE);
        }
        if (verified.status === 'success') {
          await withPaymentContext('verify', verified.raw as unknown as Record<string, unknown>, (ctx) =>
            ticketOrderConfirmService.confirmWithinTransaction(ctx, payment.reference)
          );
          break;
        }
        if (verified.status === 'failed' || verified.status === 'abandoned') {
          await withPaymentContext('verify', verified.raw as unknown as Record<string, unknown>, (ctx) =>
            ticketOrderConfirmService.failWithinTransaction(ctx, payment.reference)
          );
        }
      }
    }
    const fresh = (await ticketOrderRepository.findById(order.id))!;
    return viewForOrder(fresh);
  },

  // POST /api/ticket-orders/retry { token }: a new attempt for an order that
  // failed or expired unpaid. Its stock is held again (refused if it's gone),
  // a new reference is added and every earlier one is kept, so a late
  // success on any of them is still honoured.
  retry: async (token: unknown, now: Date = new Date()): Promise<CheckoutResult> => {
    const order = await findByToken(token);
    const event = await findSellingEvent((await eventShareToken(order.eventId)) ?? '', now);
    const reference = newReference();
    const ready = await prisma.$transaction(async (tx) => {
      await ticketOrderRepository.lock(tx, order.id);
      const fresh = (await ticketOrderRepository.findById(order.id, tx))!;
      if (fresh.status === 'PENDING' && fresh.holdReleasedAt === null && fresh.holdExpiresAt > now) {
        return { kind: 'pending' as const, order: fresh };
      }
      if (fresh.status !== 'FAILED' && fresh.status !== 'EXPIRED') {
        throw new HttpError(409, "This order can't be paid again.", CODES.RETRY_NOT_ALLOWED);
      }
      if (fresh.holdReleasedAt !== null) {
        // As at checkout: the days its tickets admit (the order's snapshot)
        // locked, each type's own quantity, then the days' capacity.
        const liveDayIds = event.eventDays.map((d) => d.id);
        const lockedDays = await lockOrderDays(tx, fresh.items, liveDayIds);
        for (const item of fresh.items) {
          if (!(await ticketOrderRepository.hold(tx, item.ticketTypeId, item.quantity))) {
            throw new HttpError(409, `There aren't enough '${item.typeName}' tickets left for this order any more.`, CODES.NOT_ENOUGH_LEFT);
          }
        }
        await assertOrderDaysHaveRoom(tx, lockedDays, fresh.items, liveDayIds, now);
      }
      await tx.ticketOrder.update({
        where: { id: fresh.id },
        data: { status: 'PENDING', holdExpiresAt: new Date(now.getTime() + HOLD_MS), holdReleasedAt: null },
      });
      await tx.ticketOrderPayment.create({ data: { orderId: fresh.id, reference } });
      await paymentLedgerService.record(
        {
          type: 'TICKET_PAYMENT_INITIATED',
          amountCents: fresh.totalCents,
          currency: fresh.currency,
          tenantId: fresh.tenantId,
          eventId: fresh.eventId,
          paystackReference: reference,
          relatedType: 'TicketOrder',
          relatedId: fresh.id,
          payload: { retry: true, earlierReferences: fresh.payments.map((p) => p.reference) } as unknown as Prisma.InputJsonValue,
        },
        tx
      );
      return { kind: 'new' as const, order: (await ticketOrderRepository.findById(fresh.id, tx))! };
    }, PAYMENT_TRANSACTION_OPTIONS);

    if (ready.kind === 'pending') return { ...viewOf(ready.order, event), orderToken: buildOrderToken(order.id), reused: true };
    const started = await initialise(ready.order, reference);
    if (!started.ok) return startFailed(ready.order, reference, started.error);
    await prisma.ticketOrderPayment.update({ where: { reference }, data: { authorizationUrl: started.url } });
    const fresh = (await ticketOrderRepository.findById(order.id))!;
    return { ...viewOf(fresh, event), orderToken: buildOrderToken(order.id), reused: false };
  },
};

const ORDER_NOT_FOUND_MESSAGE = "We couldn't find that order. Check the link in your email.";

const findByToken = async (token: unknown): Promise<OrderRow> => {
  const orderId = verifyOrderToken(token);
  const order = orderId ? await ticketOrderRepository.findById(orderId) : null;
  if (!order) throw new HttpError(404, ORDER_NOT_FOUND_MESSAGE, CODES.ORDER_NOT_FOUND);
  return order;
};

const eventShareToken = async (eventId: string): Promise<string | null> =>
  (await prisma.event.findUnique({ where: { id: eventId }, select: { shareToken: true } }))?.shareToken ?? null;

// A buyer's view of their order, whatever the event's state now.
export const viewForOrder = async (order: OrderRow): Promise<OrderView> => {
  const event = await prisma.event.findUniqueOrThrow({
    where: { id: order.eventId },
    select: {
      name: true,
      hostName: true,
      shareToken: true,
      visibility: true,
      isArchived: true,
      eventDays: { where: { isArchived: false }, orderBy: { date: 'asc' } },
    },
  });
  return toOrderView(order, { name: event.name, hostName: event.hostName, shareToken: publicShareTokenOf(event), eventDays: event.eventDays });
};

export { formatRand };
