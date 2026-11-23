import { type PlatformRole } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { ticketRepository, type TicketRow } from './ticket.repository.js';
import { type TicketTypeInput, type TicketTypeView } from './ticket.types.js';
import { resolveTicketType, toStoredTicketType, TICKET_ERROR_CODES } from './ticket-validation.util.js';
import { ticketSalesCount, ticketSalesCounts, type TicketSalesCount } from './ticket-sales-count.util.js';
import { eventService } from '../event/event.service.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatSaLocal } from '../reminder-schedule/reminder-schedule-time.util.js';
import { ticketQuantityWarnings, type TicketQuantityWarning } from '../event-day/day-capacity.util.js';

// Ticket has no tenantId of its own — ownership is transitive through its
// event, like every other event sub-resource (event-day, program-item).
// Every method gates through eventService.getScoped() (tenant scoping and
// the assignment lock: a locked member only on their assigned events) AND
// checks that the ticket belongs to the :eventId in the URL: a ticket id
// reached under any other event is the same 404 as one that doesn't exist.
//
// Organiser-only. Guests see ticket types on the public event page
// (event-public.service.ts's projection, for a paid public event only) and
// through their invite token on the invitation purchase path.
const ticketInScope = async (id: string, eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
  const event = await eventService.getScoped(eventId, requestingRole, tenantId);
  const ticket = await ticketRepository.findById(id);
  if (!ticket || ticket.eventId !== eventId) throw new HttpError(404, 'Ticket not found');
  return { event, ticket };
};

// The organiser's view: an explicit allowlist.
export const toTicketTypeView = (row: TicketRow, count: TicketSalesCount): TicketTypeView => ({
  id: row.id,
  eventId: row.eventId,
  name: row.name,
  description: row.description,
  priceCents: row.priceCents,
  currency: row.currency,
  quantity: row.totalQuantity,
  soldCount: count.sold,
  remaining: row.totalQuantity === null ? null : Math.max(0, row.totalQuantity - count.sold - count.held),
  hasSales: count.sold > 0,
  salesStart: row.salesStart,
  salesEnd: row.salesEnd,
  salesStartLocal: row.salesStart ? formatSaLocal(row.salesStart) : null,
  salesEndLocal: row.salesEnd ? formatSaLocal(row.salesEnd) : null,
  admittedDayIds: row.admitsAllDays ? null : row.admittedDays.map((d) => d.eventDayId),
  maxPerOrder: row.maxPerOrder,
  sortOrder: row.sortOrder,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const viewOf = async (row: TicketRow): Promise<TicketTypeView> => toTicketTypeView(row, await ticketSalesCount(row.id));

export const ticketService = {

  // The list, and capacityWarnings: each day (by date) whose venue capacity
  // the ACTIVE types admitting it add up to more than. Only a warning: saving
  // a type is never refused for it, and sales stop at the day's capacity.
  getAllForAdmin: async (
    eventId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<{ ticketTypes: TicketTypeView[]; capacityWarnings: TicketQuantityWarning[] }> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    const rows = await ticketRepository.findAll(eventId);
    const counts = await ticketSalesCounts(rows.map((r) => r.id));
    const days = [...event.eventDays]
      .filter((d) => !d.isArchived)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    return {
      ticketTypes: rows.map((r) => toTicketTypeView(r, counts.get(r.id) ?? { sold: 0, held: 0 })),
      capacityWarnings: ticketQuantityWarnings(
        days,
        rows.map((r) => ({ ...r, admittedDayIds: r.admittedDays.map((d) => d.eventDayId) }))
      ),
    };
  },

  getById: async (id: string, eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<TicketTypeView> =>
    viewOf((await ticketInScope(id, eventId, requestingRole, tenantId)).ticket),

  create: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: TicketTypeInput): Promise<TicketTypeView> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    const { write } = resolveTicketType(data ?? {}, null, {
      eventDays: event.eventDays,
      sold: 0,
      nextSortOrder: await ticketRepository.nextSortOrder(eventId),
    });
    return viewOf(await ticketRepository.create(eventId, userId, write));
  },

  // A change re-checks the whole type; one that changes nothing saves as is
  // (a type from before the 2026-11 rules stays saveable until edited).
  update: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: TicketTypeInput): Promise<TicketTypeView> => {
    const { event, ticket } = await ticketInScope(id, eventId, requestingRole, tenantId);
    const { sold } = await ticketSalesCount(id);
    const { write, changed } = resolveTicketType(data ?? {}, toStoredTicketType(ticket), { eventDays: event.eventDays, sold, nextSortOrder: ticket.sortOrder });
    if (!changed) return viewOf(ticket);
    return viewOf(await prisma.$transaction((tx) => ticketRepository.update(id, userId, write, tx)));
  },

  // A type with sales can't be deleted, only hidden.
  archive: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await ticketInScope(id, eventId, requestingRole, tenantId);
    if ((await ticketSalesCount(id)).sold > 0) throw ticketHasSalesError();
    return ticketRepository.archive(id, userId);
  },
};

export const ticketHasSalesError = (name?: string): HttpError =>
  new HttpError(
    409,
    `${name ? `'${name}' tickets have` : 'This ticket type has'} been sold, so it can't be deleted. Hide it instead to stop selling it.`,
    TICKET_ERROR_CODES.HAS_SALES
  );
