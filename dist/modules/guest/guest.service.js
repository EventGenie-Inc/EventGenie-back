import { guestRepository } from './guest.repository.js';
import {} from './guest.types.js';
import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import prisma from '../../shared/prisma/prisma.client.js';
import { eventService } from '../event/event.service.js';
import { eventDayRepository } from '../event-day/event-day.repository.js';
import { assertGuestsCreatable } from '../subscription-tier-config/guest-tier-enforcement.util.js';
import { normalizeEmail, assertValidEmail, normalizePhoneToE164, assertExactlyOneContact, findDuplicateContact, } from './guest-validation.util.js';
import { parseImportFile, validateImportRows } from './guest-import.engine.js';
import { buildImportTemplateWorkbook } from './guest-template.util.js';
export const guestService = {
    // Guest has no tenantId of its own — ownership is transitive through
    // its invites' parent events. Every method gates through
    // eventService.getById() (for event-scoped operations) or an
    // invites-relation filter threaded through guestRepository (for
    // by-id/tenant-wide operations), mirroring event-day.service.ts and
    // user.service.ts respectively.
    getAll: (requestingRole, tenantId, includeArchived = false) => {
        if (requestingRole === 'SUPER_ADMIN')
            return guestRepository.findAll(undefined, includeArchived);
        return guestRepository.findAll(tenantId ?? undefined, includeArchived);
    },
    getById: async (id, requestingRole, tenantId, includeArchived = false) => {
        const guest = requestingRole === 'SUPER_ADMIN'
            ? await guestRepository.findById(id, includeArchived)
            : await guestRepository.findById(id, includeArchived, tenantId ?? undefined);
        if (!guest)
            throw new HttpError(404, 'Guest not found');
        return guest;
    },
    getAllForEvent: async (eventId, requestingRole, tenantId, includeArchived = false) => {
        await eventService.getById(eventId, requestingRole, tenantId); // throws 404 if wrong tenant
        return guestRepository.findAllForEvent(eventId, includeArchived);
    },
    create: async (eventId, userId, requestingRole, tenantId, data) => {
        const event = await eventService.getById(eventId, requestingRole, tenantId);
        if (!data.eventDayIds?.length) {
            throw new HttpError(400, 'At least one eventDayId is required');
        }
        const validDayIds = new Set(event.eventDays.map((d) => d.id));
        const unknownDayId = data.eventDayIds.find((id) => !validDayIds.has(id));
        if (unknownDayId) {
            throw new HttpError(400, `Event day '${unknownDayId}' does not belong to this event`);
        }
        const email = data.email ? normalizeEmail(data.email) : null;
        if (email)
            assertValidEmail(email);
        const phoneNumber = data.phoneNumber ? normalizePhoneToE164(data.phoneNumber) : null;
        assertExactlyOneContact(email, phoneNumber);
        const existingContacts = await guestRepository.findContactsForEvent(eventId);
        const duplicate = findDuplicateContact(existingContacts.map((g) => ({ guestId: g.id, email: g.email, phoneNumber: g.phoneNumber })), { email, phoneNumber });
        if (duplicate) {
            throw new HttpError(409, `A guest with this ${email ? 'email' : 'phone number'} already exists for this event`);
        }
        await assertGuestsCreatable(eventId, event.tenantId, 1);
        return guestRepository.createWithInvite(eventId, userId, {
            firstName: data.firstName ?? null,
            surname: data.surname ?? null,
            email,
            phoneNumber,
            eventDayIds: data.eventDayIds,
        });
    },
    update: async (id, requestingRole, tenantId, data) => {
        const guest = await guestService.getById(id, requestingRole, tenantId);
        const nextEmail = data.email !== undefined
            ? (data.email === null ? null : normalizeEmail(data.email))
            : guest.email;
        const nextPhone = data.phoneNumber !== undefined
            ? (data.phoneNumber === null ? null : normalizePhoneToE164(data.phoneNumber))
            : guest.phoneNumber;
        if (nextEmail)
            assertValidEmail(nextEmail);
        assertExactlyOneContact(nextEmail, nextPhone);
        return guestRepository.update(id, {
            ...data,
            ...(data.email !== undefined && { email: nextEmail }),
            ...(data.phoneNumber !== undefined && { phoneNumber: nextPhone }),
        });
    },
    // Archiving a guest cascades to every one of their Invites — a bulk
    // send in Part 2 must never dispatch to an archived guest. Mirrors
    // tenant.service.ts's suspend cascade exactly: fetch the affected
    // children first, then one transaction flips the parent plus every
    // child together (no delegation to invite.repository.ts/service.ts for
    // the cascade writes themselves).
    archive: async (id, requestingRole, tenantId) => {
        await guestService.getById(id, requestingRole, tenantId);
        const invites = await prisma.invite.findMany({ where: { guestId: id, isArchived: false } });
        await prisma.$transaction(async (tx) => {
            await tx.guest.update({ where: { id }, data: { isArchived: true } });
            for (const invite of invites) {
                await tx.invite.update({ where: { id: invite.id }, data: { isArchived: true } });
            }
        });
        return guestRepository.findById(id, true);
    },
    reactivate: async (id, requestingRole, tenantId) => {
        // Must look up including archived — the whole point of reactivate is
        // to find a guest that is currently archived and un-archive them.
        await guestService.getById(id, requestingRole, tenantId, true);
        // Per the same v1 approach as tenant.service.ts's reactivate: this
        // uniformly reactivates every archived invite under this guest,
        // including any that may have been archived individually (via
        // invite.service.ts's own archive) before the guest itself was
        // archived. A future version could track archive origin (individual
        // vs cascade) to preserve an individually-archived invite through a
        // guest reactivation — out of scope for v1, matching the tenant
        // precedent's documented simplification.
        const invites = await prisma.invite.findMany({ where: { guestId: id, isArchived: true } });
        await prisma.$transaction(async (tx) => {
            await tx.guest.update({ where: { id }, data: { isArchived: false } });
            for (const invite of invites) {
                await tx.invite.update({ where: { id: invite.id }, data: { isArchived: false } });
            }
        });
        return guestRepository.findById(id, true);
    },
    getImportTemplate: async (eventId, requestingRole, tenantId) => {
        const event = await eventService.getById(eventId, requestingRole, tenantId);
        const eventDays = await eventDayRepository.findAll(eventId);
        return buildImportTemplateWorkbook(event, eventDays);
    },
    importGuests: async (eventId, userId, requestingRole, tenantId, file) => {
        const event = await eventService.getById(eventId, requestingRole, tenantId);
        const rows = await parseImportFile(file.buffer, file.originalname, file.mimetype);
        const eventDays = await eventDayRepository.findAll(eventId);
        const existingGuests = await guestRepository.findContactsForEvent(eventId);
        const existingContacts = existingGuests.map((g) => ({ guestId: g.id, email: g.email, phoneNumber: g.phoneNumber }));
        const { totalRows, validRows, failures } = validateImportRows(rows, eventDays, existingContacts);
        if (validRows.length > 0) {
            await assertGuestsCreatable(eventId, event.tenantId, validRows.length);
            await guestRepository.bulkCreateWithInvites(eventId, userId, validRows);
        }
        return { totalRows, created: validRows.length, failed: failures.length, failures };
    },
};
//# sourceMappingURL=guest.service.js.map