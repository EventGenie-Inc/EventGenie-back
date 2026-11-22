import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient | typeof prisma;

// ─────────────────────────────────────────
//  HOW MANY OF A TICKET TYPE ARE SOLD (ticket sales Round A)
//
//  The one place every rule that depends on sales asks: a type with sales
//  can't be deleted, its quantity can't go below what is sold, its admitted
//  days can't change, a day it admits can't be removed, and sales can't be
//  switched off. `held` is stock claimed by a checkout still in progress:
//  it counts against what is left ("sold out", "only N left"), not as sold.
//
//  Round A reads the Ticket row's own counters, which only the invitation
//  purchase path moves today (so for every public type they are 0). Round B
//  fills this function from its own orders; no caller changes.
// ─────────────────────────────────────────

export interface TicketSalesCount {
  sold: number;
  held: number;
}

export const ticketSalesCounts = async (ticketIds: string[], db: Db = prisma): Promise<Map<string, TicketSalesCount>> => {
  const counts = new Map<string, TicketSalesCount>();
  if (ticketIds.length === 0) return counts;
  const rows = await db.ticket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, soldCount: true, heldCount: true } });
  for (const id of ticketIds) {
    const row = rows.find((r) => r.id === id);
    counts.set(id, { sold: row?.soldCount ?? 0, held: row?.heldCount ?? 0 });
  }
  return counts;
};

export const ticketSalesCount = async (ticketId: string, db: Db = prisma): Promise<TicketSalesCount> =>
  (await ticketSalesCounts([ticketId], db)).get(ticketId) ?? { sold: 0, held: 0 };

// Tickets sold for the whole event (every type, archived ones included).
export const eventTicketsSold = async (eventId: string, db: Db = prisma): Promise<number> => {
  const ids = (await db.ticket.findMany({ where: { eventId }, select: { id: true } })).map((t) => t.id);
  let sold = 0;
  for (const count of (await ticketSalesCounts(ids, db)).values()) sold += count.sold;
  return sold;
};
