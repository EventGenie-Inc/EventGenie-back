import { type PlatformRole, type Prisma, type TicketOrderStatus } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { adminAuditService } from '../admin-audit/admin-audit.service.js';
import { ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.types.js';
import { ticketOrderRepository } from '../ticket-order/ticket-order.repository.js';
import { ticketOrderConfirmService } from '../ticket-order/ticket-order-confirm.service.js';
import { ticketOrderEmails } from '../ticket-order/ticket-order-emails.js';
import { ticketSalesCounts } from '../ticket/ticket-sales-count.util.js';
import { PAYMENT_TRANSACTION_OPTIONS } from '../payment-webhook/payment-context.util.js';

// ─────────────────────────────────────────
//  THE ORGANISER'S SALES VIEW, AND CANCELLING TICKETS (ticket sales Round B)
//
//  /api/events/:eventId/ticket-sales/{summary,orders,orders/:orderId/cancel}:
//  the event's admins only (requireEventAdmin, then eventService.getScoped:
//  tenant scoping and the assignment lock). Buyers' names, emails and
//  phones are here and nowhere else an organiser-facing list reaches.
//
//  Cancelling (one ticket, some, or the whole order, with a reason): the
//  tickets are CANCELLED (their QR stops working at once), their places
//  freed, the buyer emailed (naming the tickets and the reason, and that the
//  organiser handles any refund), and it is audited. It can't be undone.
//  Nothing moves money and Paystack isn't called: refunds are the
//  organiser's own (Refunds, version 1).
// ─────────────────────────────────────────

export const TICKET_CANCEL_CODES = {
  REASON_REQUIRED: 'TICKET_CANCEL_REASON_REQUIRED',
  NOTHING_TO_CANCEL: 'TICKET_CANCEL_NOTHING_TO_CANCEL',
  ORDER_NOT_FOUND: 'TICKET_ORDER_NOT_FOUND',
  INVALID: 'TICKET_CANCEL_REQUEST_INVALID',
} as const;

const MAX_REASON = 500;
const PAGE_SIZE_MAX = 100;
const ORDER_STATUSES: TicketOrderStatus[] = ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'UNDER_REVIEW', 'REFUNDED', 'REVERSED'];

const confirmedWhere: Prisma.TicketOrderWhereInput = { OR: [{ status: 'PAID' }, { status: 'UNDER_REVIEW', reviewReason: 'DISPUTE' }] };

export const ticketSalesOrdersService = {
  // Per type: sold, remaining, and the organiser's revenue (the ticket
  // subtotal of tickets still valid: never the fees).
  summary: async (eventId: string, role: PlatformRole, tenantId: string | null) => {
    await eventService.getScoped(eventId, role, tenantId);
    const types = await prisma.ticket.findMany({ where: { eventId, isArchived: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const counts = await ticketSalesCounts(types.map((t) => t.id));
    const valid = await prisma.issuedTicket.findMany({
      where: { eventId, status: 'VALID', order: confirmedWhere },
      select: { ticketTypeId: true, orderItemId: true },
    });
    const items = await prisma.ticketOrderItem.findMany({
      where: { id: { in: [...new Set(valid.map((v) => v.orderItemId))] } },
      select: { id: true, unitPriceCents: true },
    });
    const priceOf = new Map(items.map((i) => [i.id, i.unitPriceCents]));
    const rows = types.map((t) => {
      const mine = valid.filter((v) => v.ticketTypeId === t.id);
      const count = counts.get(t.id) ?? { sold: 0, held: 0 };
      return {
        ticketTypeId: t.id,
        name: t.name,
        status: t.status,
        priceCents: t.priceCents,
        quantity: t.totalQuantity,
        sold: mine.length,
        held: count.held,
        remaining: t.totalQuantity === null ? null : Math.max(0, t.totalQuantity - count.sold - count.held),
        revenueCents: mine.reduce((sum, v) => sum + (priceOf.get(v.orderItemId) ?? 0), 0),
      };
    });
    return {
      types: rows,
      totals: { sold: rows.reduce((s, r) => s + r.sold, 0), revenueCents: rows.reduce((s, r) => s + r.revenueCents, 0) },
    };
  },

  // Orders, newest first: buyer, items, amounts, status, date, and each
  // ticket with its status and check-ins per day.
  orders: async (eventId: string, role: PlatformRole, tenantId: string | null, query: Record<string, unknown>) => {
    await eventService.getScoped(eventId, role, tenantId);
    const page = Math.max(1, Number.parseInt(String(query['page'] ?? '1'), 10) || 1);
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number.parseInt(String(query['pageSize'] ?? '25'), 10) || 25));
    const status = typeof query['status'] === 'string' ? query['status'].toUpperCase() : null;
    if (status && !ORDER_STATUSES.includes(status as TicketOrderStatus)) throw new HttpError(400, 'Unknown order status.');
    const search = typeof query['search'] === 'string' ? query['search'].trim() : '';
    const where: Prisma.TicketOrderWhereInput = {
      eventId,
      ...(status && { status: status as TicketOrderStatus }),
      ...(search && {
        OR: [
          { buyerName: { contains: search, mode: 'insensitive' } },
          { buyerEmail: { contains: search, mode: 'insensitive' } },
          { tickets: { some: { number: { contains: search.toUpperCase() } } } },
        ],
      }),
    };
    const [total, rows] = await Promise.all([
      prisma.ticketOrder.count({ where }),
      prisma.ticketOrder.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { items: true, tickets: { orderBy: { indexInOrder: 'asc' }, include: { checkIns: true } } },
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((o) => ({
        id: o.id,
        status: o.status,
        reviewReason: o.reviewReason,
        disputeStatus: o.disputeStatus,
        oversold: o.oversold,
        buyer: { name: o.buyerName, email: o.buyerEmail, phone: o.buyerPhone },
        items: o.items.map((i) => ({ ticketTypeId: i.ticketTypeId, typeName: i.typeName, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
        amounts: { subtotalCents: o.subtotalCents, feesCents: o.transactionChargeCents, totalCents: o.totalCents, currency: o.currency },
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        tickets: o.tickets.map((t) => ({
          id: t.id,
          number: t.number,
          typeName: o.items.find((i) => i.id === t.orderItemId)?.typeName ?? '',
          label: `Ticket ${t.indexInOrder} of ${o.tickets.length}`,
          status: t.status,
          cancelReason: t.cancelReason,
          voidedAt: t.voidedAt,
          checkIns: t.checkIns.map((c) => ({ eventDayId: c.eventDayId, checkedInAt: c.checkedInAt })),
        })),
      })),
    };
  },

  // { reason, ticketIds? } (left out: every valid ticket of the order).
  cancel: async (eventId: string, orderId: string, userId: string, role: PlatformRole, tenantId: string | null, body: unknown) => {
    const event = await eventService.getScoped(eventId, role, tenantId);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'The request body must be an object.', TICKET_CANCEL_CODES.INVALID);
    const { reason: rawReason, ticketIds: rawIds } = body as { reason?: unknown; ticketIds?: unknown };
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (!reason) throw new HttpError(422, 'Give a reason: the buyer is told it.', TICKET_CANCEL_CODES.REASON_REQUIRED);
    if (reason.length > MAX_REASON) throw new HttpError(422, `The reason can be at most ${MAX_REASON} characters.`, TICKET_CANCEL_CODES.REASON_REQUIRED);
    if (rawIds !== undefined && (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === 'string') || rawIds.length === 0)) {
      throw new HttpError(400, 'ticketIds must be a list of ticket ids, or left out for the whole order.', TICKET_CANCEL_CODES.INVALID);
    }
    const ticketIds = rawIds === undefined ? null : [...new Set(rawIds as string[])];

    const outcome = await prisma.$transaction(async (tx) => {
      const found = await tx.ticketOrder.findFirst({ where: { id: orderId, eventId }, select: { id: true } });
      if (!found) throw new HttpError(404, 'Order not found', TICKET_CANCEL_CODES.ORDER_NOT_FOUND);
      await ticketOrderRepository.lock(tx, orderId);
      const order = (await ticketOrderRepository.findById(orderId, tx))!;
      if (ticketIds && !ticketIds.every((id) => order.tickets.some((t) => t.id === id))) {
        throw new HttpError(404, 'Ticket not found', TICKET_CANCEL_CODES.ORDER_NOT_FOUND);
      }
      const voided = await ticketOrderConfirmService.voidTickets(tx, order, 'CANCELLED', ticketIds, { cancelReason: reason, cancelledByUserId: userId });
      if (voided.length === 0) throw new HttpError(409, 'There are no valid tickets to cancel.', TICKET_CANCEL_CODES.NOTHING_TO_CANCEL);
      return { order, voided };
    }, PAYMENT_TRANSACTION_OPTIONS);

    const cancelled = outcome.order.tickets
      .filter((t) => outcome.voided.includes(t.id))
      .map((t) => ({
        ticketId: t.id,
        number: t.number,
        wasCheckedIn: t.checkIns.length > 0,
        checkedInDays: t.checkIns.map((c) => ({ eventDayId: c.eventDayId, checkedInAt: c.checkedInAt })),
      }));

    await adminAuditService
      .record({
        actorUserId: userId,
        tenantId: event.tenantId,
        action: ADMIN_AUDIT_ACTIONS.TICKETS_CANCELLED,
        details: { eventId, orderId, tickets: cancelled.map((c) => ({ ticketId: c.ticketId, number: c.number, wasCheckedIn: c.wasCheckedIn })), reason },
      })
      .catch((err: unknown) => console.error(`[ticket-sales] audit entry for cancelling tickets of order ${orderId} not written:`, err));

    const emailSent = await ticketOrderEmails.cancelled(orderId, outcome.voided, reason);
    return { orderId, cancelled, emailSent };
  },
};
