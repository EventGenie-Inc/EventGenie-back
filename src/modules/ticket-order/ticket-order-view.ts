import { buildPassPayload } from '../check-in-pass/check-in-pass-token.util.js';
import { type OrderRow } from './ticket-order.repository.js';
import { type OrderDayView, type OrderTicketView, type OrderView } from './ticket-order.types.js';

// ─────────────────────────────────────────
//  WHAT A BUYER SEES OF THEIR ORDER (no sign-in: the order token)
//
//  An explicit allowlist (STEERING "Guest-facing responses"): never the
//  payout subaccount, the references, Paystack's fee, the idempotency key or
//  anyone else's details. Tickets only once the order is confirmed (PAID, or
//  a chargeback still open), each with its QR payload when it is VALID and
//  admits at least one venue day; an online day's link with it.
// ─────────────────────────────────────────

export interface EventForView {
  name: string;
  hostName: string | null;
  eventDays: {
    id: string;
    label: string;
    date: Date;
    startTime: Date | null;
    endTime: Date | null;
    locationType: 'VENUE' | 'ONLINE' | null;
    location: string | null;
    address: string | null;
    onlineUrl: string | null;
  }[];
}

// The days a ticket admits: its type's at checkout (every live day, or the
// chosen ones still live), earliest first.
export const admittedDaysOf = <D extends { id: string; date: Date }>(
  item: { admitsAllDays: boolean; admittedDayIds: string[] },
  days: D[]
): D[] =>
  days
    .filter((d) => item.admitsAllDays || item.admittedDayIds.includes(d.id))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

// A ticket's QR: only while it can admit someone at a door.
export const ticketPayloadOf = (
  ticket: { id: string; status: string },
  days: { locationType: 'VENUE' | 'ONLINE' | null }[]
): string | null =>
  ticket.status === 'VALID' && days.some((d) => d.locationType !== 'ONLINE') ? buildPassPayload({ id: ticket.id, kind: 'TICKET' }) : null;

export const ticketLabel = (index: number, count: number): string => `Ticket ${index} of ${count}`;

// Confirmed: the tickets are the buyer's (a chargeback open keeps them
// valid; a mismatch held for review has none).
export const orderHasTickets = (order: { status: string; reviewReason: string | null }): boolean =>
  order.status === 'PAID' ||
  order.status === 'REFUNDED' ||
  order.status === 'REVERSED' ||
  (order.status === 'UNDER_REVIEW' && order.reviewReason === 'DISPUTE');

const dayView = (d: EventForView['eventDays'][number], withLink: boolean): OrderDayView => ({
  id: d.id,
  label: d.label,
  date: d.date,
  startTime: d.startTime,
  endTime: d.endTime,
  locationType: d.locationType === 'ONLINE' ? 'ONLINE' : 'VENUE',
  location: d.locationType === 'ONLINE' ? 'Online' : d.location,
  address: d.locationType === 'ONLINE' ? null : d.address,
  onlineUrl: withLink && d.locationType === 'ONLINE' ? d.onlineUrl : null,
});

export const toOrderView = (order: OrderRow, event: EventForView, now: Date = new Date()): OrderView => {
  const confirmed = orderHasTickets(order);
  const latest = order.payments[order.payments.length - 1] ?? null;
  const holding = order.status === 'PENDING' && order.holdReleasedAt === null && order.holdExpiresAt > now;
  const tickets: OrderTicketView[] = confirmed
    ? order.tickets.map((t) => {
        const item = order.items.find((i) => i.id === t.orderItemId)!;
        const days = admittedDaysOf(item, event.eventDays);
        const valid = t.status === 'VALID';
        return {
          id: t.id,
          number: t.number,
          typeName: item.typeName,
          label: ticketLabel(t.indexInOrder, order.tickets.length),
          status: t.status,
          days: days.map((d) => dayView(d, valid)),
          payload: ticketPayloadOf(t, days),
        };
      })
    : [];
  return {
    orderId: order.id,
    status: order.status,
    event: { name: event.name, hostName: event.hostName },
    buyer: { name: order.buyerName, email: order.buyerEmail, phone: order.buyerPhone },
    items: order.items.map((i) => ({ ticketTypeId: i.ticketTypeId, typeName: i.typeName, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
    amounts: {
      subtotalCents: order.subtotalCents,
      commissionCents: order.commissionCents,
      platformFixedFeeCents: order.platformFixedFeeCents,
      processingFeeCents: order.processingFeeCents,
      feesCents: order.transactionChargeCents,
      totalCents: order.totalCents,
      currency: order.currency,
    },
    authorizationUrl: holding ? (latest?.authorizationUrl ?? null) : null,
    holdExpiresAt: holding ? order.holdExpiresAt : null,
    tickets,
  };
};
