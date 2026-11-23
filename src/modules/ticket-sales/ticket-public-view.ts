import prisma from '../../shared/prisma/prisma.client.js';
import { ticketSalesCounts } from '../ticket/ticket-sales-count.util.js';
import { effectiveRemaining, placesLeftByDay } from '../ticket/ticket-day-capacity.util.js';
import { lastDayEndsAt } from '../ticket/ticket-validation.util.js';
import { formatSaLocal } from '../reminder-schedule/reminder-schedule-time.util.js';
import { calculateTicketOrderFees } from './ticket-fee-calculator.js';

// ─────────────────────────────────────────
//  TICKET TYPES ON THE PUBLIC EVENT PAGE (ticket sales Round A)
//
//  GET /api/public-events/:shareToken's `ticketSales`, for an event selling
//  tickets (event-public.service.ts). An explicit allowlist, per visible
//  type: never a hidden or deleted type, never the payout account, never
//  how many are sold or how many there are. "Only N left" (`remaining`)
//  only when 10 or fewer are left (ONLY_N_LEFT_THRESHOLD).
//
//  Prices: the ticket's own (`priceCents`), the all-in price of one ticket
//  (`allInPriceCents`, what one ticket alone costs the guest), and the
//  fees for one ticket, split (commission, e-velope's fixed fee, processing).
//  Both are returned: the page's wording waits for legal advice. All from
//  the one fee calculator. A bigger order costs a little less than n × the
//  all-in price (Paystack's flat fee is charged once per payment); Round B's
//  checkout prices the order itself.
//
//  Availability (Round B's counts decide sold out):
//   SALES_ENDED      its sales window closed, or the event's last day ended;
//   NOT_YET_ON_SALE  its sales window hasn't opened;
//   SOLD_OUT         none left (sold, or held by checkouts in progress);
//   ON_SALE          otherwise.
//  "Left" is the type's EFFECTIVE remaining: the lowest of its own
//  remaining and the places left (counting holds) on each day it admits
//  that has a venue capacity (ticket-day-capacity.util.ts). SOLD_OUT and
//  "only N left" both use it. A day's capacity is never shown, only the
//  type's availability.
//  Pausing sales doesn't change a type's availability: `paused` says so.
// ─────────────────────────────────────────

export const ONLY_N_LEFT_THRESHOLD = 10;

export type PublicTicketAvailability = 'ON_SALE' | 'NOT_YET_ON_SALE' | 'SALES_ENDED' | 'SOLD_OUT';

export interface PublicTicketType {
  id: string;
  name: string;
  description: string | null;
  // The days it admits (every live day of the event, unless chosen ones).
  days: { id: string; label: string; date: Date }[];
  priceCents: number;
  allInPriceCents: number;
  fees: {
    commissionCents: number;
    platformFixedFeeCents: number;
    processingFeeCents: number;
    totalCents: number;
  };
  availability: PublicTicketAvailability;
  // The instants, and the same in South African time ("2027-03-02T18:00"),
  // as the organiser entered them.
  salesStart: Date | null;
  salesEnd: Date | null;
  salesStartLocal: string | null;
  salesEndLocal: string | null;
  // Only when 1 to 10 are left (and on sale); otherwise null.
  remaining: number | null;
  maxPerOrder: number;
}

export interface PublicTicketSales {
  // Sales paused by the organiser: nothing can be bought for now.
  paused: boolean;
  ticketTypes: PublicTicketType[];
}

export const buildPublicTicketSales = async (
  event: { id: string; salesPaused: boolean; eventDays: { id: string; label: string; date: Date; endTime: Date | null }[] },
  now: Date = new Date()
): Promise<PublicTicketSales> => {
  const rows = await prisma.ticket.findMany({
    where: { eventId: event.id, isArchived: false, status: 'ACTIVE' },
    include: { admittedDays: { select: { eventDayId: true } } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const counts = await ticketSalesCounts(rows.map((r) => r.id));
  const liveDayIds = event.eventDays.map((d) => d.id);
  const placesLeft = await placesLeftByDay(liveDayIds, prisma, now);
  const eventEnds = lastDayEndsAt(event.eventDays);

  const ticketTypes = rows.map((row): PublicTicketType => {
    const fees = calculateTicketOrderFees({ unitPriceCents: row.priceCents, quantity: 1 });
    const count = counts.get(row.id) ?? { sold: 0, held: 0 };
    const own = row.totalQuantity === null ? null : Math.max(0, row.totalQuantity - count.sold - count.held);
    const left = effectiveRemaining(own, { admitsAllDays: row.admitsAllDays, admittedDayIds: row.admittedDays.map((d) => d.eventDayId) }, liveDayIds, placesLeft);
    const availability: PublicTicketAvailability =
      (row.salesEnd && row.salesEnd <= now) || (eventEnds && eventEnds <= now)
        ? 'SALES_ENDED'
        : row.salesStart && row.salesStart > now
          ? 'NOT_YET_ON_SALE'
          : left === 0
            ? 'SOLD_OUT'
            : 'ON_SALE';
    const chosen = new Set(row.admittedDays.map((d) => d.eventDayId));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      days: event.eventDays
        .filter((d) => row.admitsAllDays || chosen.has(d.id))
        .map((d) => ({ id: d.id, label: d.label, date: d.date })),
      priceCents: row.priceCents,
      allInPriceCents: fees.totalCents,
      fees: {
        commissionCents: fees.commissionCents,
        platformFixedFeeCents: fees.platformFixedFeeCents,
        processingFeeCents: fees.processingFeeCents,
        totalCents: fees.totalCents - fees.subtotalCents,
      },
      availability,
      salesStart: row.salesStart,
      salesEnd: row.salesEnd,
      salesStartLocal: row.salesStart ? formatSaLocal(row.salesStart) : null,
      salesEndLocal: row.salesEnd ? formatSaLocal(row.salesEnd) : null,
      remaining: availability === 'ON_SALE' && left !== null && left <= ONLY_N_LEFT_THRESHOLD ? left : null,
      maxPerOrder: row.maxPerOrder,
    };
  });
  return { paused: event.salesPaused, ticketTypes };
};
