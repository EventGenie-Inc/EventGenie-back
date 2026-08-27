import { eventRepository } from './event.repository.js';
import {} from './event.types.js';
import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertEventCreatable, assertEventUpdatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
export const eventService = {
    getAll: (requestingRole, tenantId) => {
        if (requestingRole === 'SUPER_ADMIN')
            return eventRepository.findAll();
        return eventRepository.findAll(tenantId ?? undefined);
    },
    getById: async (id, requestingRole, tenantId) => {
        const event = requestingRole === 'SUPER_ADMIN'
            ? await eventRepository.findById(id)
            : await eventRepository.findById(id, tenantId ?? undefined);
        if (!event)
            throw new HttpError(404, 'Event not found');
        return event;
    },
    create: async (tenantId, userId, data) => {
        await assertEventCreatable(tenantId, {
            ...(data.visibility !== undefined && { visibility: data.visibility }),
            ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
        });
        return eventRepository.create(tenantId, userId, data);
    },
    update: async (id, userId, requestingRole, tenantId, data) => {
        // Tier rules are evaluated against the EVENT's owning tenant, not the
        // requester's — a SUPER_ADMIN editing a SPARK tenant's event must still
        // be bound by that tenant's plan, and a SUPER_ADMIN has no tenantId of
        // their own to fall back on.
        const event = await eventService.getById(id, requestingRole, tenantId);
        await assertEventUpdatable(event.tenantId, {
            ...(data.visibility !== undefined && { visibility: data.visibility }),
            ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
        });
        return eventRepository.update(id, userId, data);
    },
    archive: async (id, userId, requestingRole, tenantId) => {
        await eventService.getById(id, requestingRole, tenantId);
        return eventRepository.archive(id, userId);
    },
    // PUBLIC-only: the organiser copies this link, no per-guest token or
    // guest record involved. NOTE: no guest self-registration flow exists
    // yet anywhere in the codebase (confirmed — rsvp.router.ts is entirely
    // token-driven via a pre-existing Invite), so this endpoint returns a
    // URL contract only; nothing on the backend currently resolves it into
    // a working RSVP for a stranger holding the link. That flow is out of
    // scope here.
    getShareLink: async (id, requestingRole, tenantId) => {
        const event = await eventService.getById(id, requestingRole, tenantId);
        if (event.visibility !== 'PUBLIC') {
            throw new HttpError(400, 'Share links are only available for public events — private events use individual invites instead.');
        }
        return { url: `${process.env.FRONTEND_BASE_URL}/rsvp?eventId=${event.id}` };
    },
};
//# sourceMappingURL=event.service.js.map