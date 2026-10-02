import {} from '@prisma/client';
import { ticketRepository } from './ticket.repository.js';
import {} from './ticket.types.js';
import { requireTicketName, requireTicketPrice } from './ticket-validation.util.js';
import { eventService } from '../event/event.service.js';
import { HttpError } from '../../shared/errors/http-error.js';
// Ticket has no tenantId of its own — ownership is transitive through its
// event, like every other event sub-resource (event-day, program-item).
// Every method gates through eventService.getScoped() (404 for another
// tenant's event, SUPER_ADMIN unscoped) AND checks that the ticket belongs
// to the :eventId in the URL: a ticket id reached under any other event —
// another tenant's or the same tenant's — is the same 404 as one that
// doesn't exist. Before this, these endpoints did no scoping at all: any
// EVENT_ADMIN could create, edit or archive any event's tickets by id, and
// both reads were unauthenticated.
//
// Organiser-only by design. Guests never read tickets here: they see the
// purchasable ones through their invite token (rsvp.service.ts's
// validate() projection, and POST /api/rsvp/ticket-quote), and the public
// event page (event-public.service.ts) shows none.
const ticketInScope = async (id, eventId, requestingRole, tenantId) => {
    await eventService.getScoped(eventId, requestingRole, tenantId);
    const ticket = await ticketRepository.findById(id);
    if (!ticket || ticket.eventId !== eventId)
        throw new HttpError(404, 'Ticket not found');
    return ticket;
};
export const ticketService = {
    getAllForAdmin: async (eventId, requestingRole, tenantId) => {
        await eventService.getScoped(eventId, requestingRole, tenantId);
        return ticketRepository.findAll(eventId);
    },
    getById: (id, eventId, requestingRole, tenantId) => ticketInScope(id, eventId, requestingRole, tenantId),
    create: async (eventId, userId, requestingRole, tenantId, data) => {
        await eventService.getScoped(eventId, requestingRole, tenantId);
        const name = requireTicketName(data.name);
        const price = requireTicketPrice(data.price, name);
        return ticketRepository.create(eventId, userId, { ...data, name, price });
    },
    update: async (id, eventId, userId, requestingRole, tenantId, data) => {
        const ticket = await ticketInScope(id, eventId, requestingRole, tenantId);
        const name = data.name !== undefined ? requireTicketName(data.name) : undefined;
        if (data.price !== undefined)
            requireTicketPrice(data.price, name ?? ticket.name);
        return ticketRepository.update(id, userId, { ...data, ...(name !== undefined && { name }) });
    },
    archive: async (id, eventId, userId, requestingRole, tenantId) => {
        await ticketInScope(id, eventId, requestingRole, tenantId);
        return ticketRepository.archive(id, userId);
    },
};
//# sourceMappingURL=ticket.service.js.map