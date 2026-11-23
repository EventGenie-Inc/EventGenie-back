import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  CHECKING IN A TICKET (ticket sales Round B; STEERING "Check-in")
//
//  A ticket is checked in per day it admits, one TicketCheckIn row per
//  ticket per day (the unique pair decides, never read-then-write): a QR
//  scan and the guest list record the same row, and undo deletes it, so the
//  two always agree, exactly as for a guest's invite (CheckIn).
//
//  A ticket admits someone while it is VALID and its order is confirmed
//  (PAID, or a chargeback still open: the tickets stay valid until it is
//  lost). It admits the days its type admitted at checkout (every live day,
//  or the chosen ones still live).
// ─────────────────────────────────────────

const ticketInclude = {
  order: { select: { id: true, status: true, reviewReason: true, buyerName: true, createdAt: true, _count: { select: { tickets: true } } } },
  ticketType: { select: { name: true } },
  checkIns: true,
} satisfies Prisma.IssuedTicketInclude;

export type TicketForCheckIn = Prisma.IssuedTicketGetPayload<{ include: typeof ticketInclude }> & {
  item: { admitsAllDays: boolean; admittedDayIds: string[]; typeName: string };
};

export const findTicket = async (ticketId: string): Promise<TicketForCheckIn | null> => {
  const ticket = await prisma.issuedTicket.findUnique({ where: { id: ticketId }, include: ticketInclude });
  if (!ticket) return null;
  const item = await prisma.ticketOrderItem.findUniqueOrThrow({
    where: { id: ticket.orderItemId },
    select: { admitsAllDays: true, admittedDayIds: true, typeName: true },
  });
  return { ...ticket, item };
};

export const ticketOrderConfirmed = (order: { status: string; reviewReason: string | null }): boolean =>
  order.status === 'PAID' || (order.status === 'UNDER_REVIEW' && order.reviewReason === 'DISPUTE');

export const ticketAdmits = (ticket: TicketForCheckIn): boolean => ticket.status === 'VALID' && ticketOrderConfirmed(ticket.order);

export const ticketAdmitsDay = (item: { admitsAllDays: boolean; admittedDayIds: string[] }, dayId: string): boolean =>
  item.admitsAllDays || item.admittedDayIds.includes(dayId);

// "Ticket 2 of 3 · General"
export const ticketDetail = (ticket: TicketForCheckIn): string =>
  `Ticket ${ticket.indexInOrder} of ${ticket.order._count.tickets} · ${ticket.item.typeName}`;

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'P2002';

// The one ticket check-in write. Idempotent and race-safe; the caller has
// already decided the ticket admits this day.
export const recordTicketArrival = async (
  ticketId: string,
  dayId: string,
  userId: string
): Promise<{ created: boolean; checkInAt: Date; checkedBy: string }> => {
  const existing = await prisma.ticketCheckIn.findUnique({ where: { issuedTicketId_eventDayId: { issuedTicketId: ticketId, eventDayId: dayId } } });
  if (existing) return { created: false, checkInAt: existing.checkedInAt, checkedBy: existing.checkedBy };
  try {
    const row = await prisma.ticketCheckIn.create({ data: { issuedTicketId: ticketId, eventDayId: dayId, checkedBy: userId } });
    return { created: true, checkInAt: row.checkedInAt, checkedBy: row.checkedBy };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const row = await prisma.ticketCheckIn.findUniqueOrThrow({ where: { issuedTicketId_eventDayId: { issuedTicketId: ticketId, eventDayId: dayId } } });
    return { created: false, checkInAt: row.checkedInAt, checkedBy: row.checkedBy };
  }
};

export const undoTicketArrival = async (ticketId: string, dayId: string): Promise<boolean> =>
  (await prisma.ticketCheckIn.deleteMany({ where: { issuedTicketId: ticketId, eventDayId: dayId } })).count > 0;

// The door list's tickets for a day: every VALID ticket of a confirmed order
// that admits it, with whether it's in. Ordered by buyer, then order (oldest
// first), then each ticket's stored position in its order (indexInOrder, the
// "Ticket N of M" the order view, the email and the PDF show), so a buyer's
// tickets read 1, 2, 3. (fix/payments-go-live: it was buyer, then the random
// ticket number, which put "Ticket 2 of 2" first about half the time.)
export const findRosterTickets = async (eventId: string, dayId: string) => {
  const tickets = await prisma.issuedTicket.findMany({
    where: {
      eventId,
      status: 'VALID',
      order: { OR: [{ status: 'PAID' }, { status: 'UNDER_REVIEW', reviewReason: 'DISPUTE' }] },
    },
    include: { ...ticketInclude, checkIns: { where: { eventDayId: dayId } } },
  });
  const items = await prisma.ticketOrderItem.findMany({
    where: { id: { in: [...new Set(tickets.map((t) => t.orderItemId))] } },
    select: { id: true, admitsAllDays: true, admittedDayIds: true, typeName: true },
  });
  return tickets
    .map((t) => ({ ...t, item: items.find((i) => i.id === t.orderItemId)! }))
    .filter((t) => ticketAdmitsDay(t.item, dayId))
    .sort(
      (a, b) =>
        a.order.buyerName.localeCompare(b.order.buyerName) ||
        a.order.createdAt.getTime() - b.order.createdAt.getTime() ||
        a.order.id.localeCompare(b.order.id) ||
        a.indexInOrder - b.indexInOrder
    );
};
