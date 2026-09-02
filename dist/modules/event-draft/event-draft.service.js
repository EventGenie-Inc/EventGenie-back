import prisma from '../../shared/prisma/prisma.client.js';
import { eventDraftRepository } from './event-draft.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import {} from './event-draft.types.js';
import {} from '@prisma/client';
import { assertEventCreatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { assertValidCoordinates } from '../event/event-coordinates.util.js';
import { assertValidRsvpDeadline } from '../event/event-rsvp-deadline.util.js';
import { assertValidCapacity } from '../event/event-capacity.util.js';
import { isCoverImageTooLarge, coverImageTooLargeMessage } from '../event/event-cover-image.util.js';
import { destroyAsset } from '../../shared/cloudinary/cloudinary.client.js';
export const eventDraftService = {
    getCurrentDraft: (tenantId, userId) => eventDraftRepository.findByTenantAndUser(tenantId, userId),
    saveDraft: (tenantId, userId, data) => eventDraftRepository.upsert(tenantId, userId, data),
    discardDraft: async (tenantId, userId) => {
        const draft = await eventDraftRepository.findByTenantAndUser(tenantId, userId);
        if (!draft)
            throw new HttpError(404, 'No draft found to discard');
        return eventDraftRepository.delete(draft.id);
    },
    materialize: async (tenantId, userId) => {
        const draft = await eventDraftRepository.findByTenantAndUser(tenantId, userId);
        if (!draft)
            throw new HttpError(404, 'No draft found to create event from');
        // Payload shape is owned by the frontend wizard and stored opaquely —
        // only the fields actually needed here are validated/read.
        const p = draft.payload;
        if (!p.name || !p.location || !Array.isArray(p.days) || p.days.length === 0) {
            throw new HttpError(400, 'Event is missing required fields (name, location, at least one day)');
        }
        const days = p.days;
        // Duplicate day labels within this draft would make the import
        // engine's Day-column matching ambiguous later — checked purely
        // in-memory, before the transaction starts, since the event doesn't
        // exist yet and there's nothing external to race against. Matches
        // event-day-validation.util.ts's case-insensitive rule.
        const seenLabels = new Set();
        for (const day of days) {
            const label = String(day.label ?? '').trim().toLowerCase();
            if (seenLabels.has(label)) {
                throw new HttpError(409, `Duplicate day label '${day.label}' — day labels must be unique within an event`);
            }
            seenLabels.add(label);
        }
        // Draft payload is opaque JSON — coerce before validating rather than
        // trusting the frontend sent numbers. Same both-or-neither, plausible-
        // range rule as the direct POST/PUT paths in event.service.ts.
        const latitude = p.latitude !== undefined && p.latitude !== null ? Number(p.latitude) : undefined;
        const longitude = p.longitude !== undefined && p.longitude !== null ? Number(p.longitude) : undefined;
        assertValidCoordinates(latitude, longitude);
        // Same both-or-neither/plausibility treatment extended to the two
        // Batch A fields — the wizard is the primary event-creation path, so
        // leaving these validated only on the direct POST would make the
        // deadline/capacity feature unreachable from real event creation.
        const capacity = p.capacity !== undefined && p.capacity !== null ? Number(p.capacity) : undefined;
        assertValidCapacity(capacity);
        const rsvpDeadline = p.rsvpDeadline !== undefined && p.rsvpDeadline !== null ? new Date(p.rsvpDeadline) : undefined;
        const draftEventDays = days.map((day) => ({
            date: new Date(day.date),
            endTime: day.endTime ? new Date(day.endTime) : null,
        }));
        assertValidRsvpDeadline(rsvpDeadline ?? null, draftEventDays, { rejectPast: true });
        // Same size-limit + cleanup-of-the-already-uploaded-file treatment as
        // the direct POST path (event.service.ts) — see event-cover-image.util.ts
        // for why this can only be checked here, after Cloudinary has already
        // reported the file's size back to the frontend.
        const coverImagePublicId = typeof p.coverImagePublicId === 'string' ? p.coverImagePublicId : undefined;
        const coverImageBytes = typeof p.coverImageBytes === 'number' ? p.coverImageBytes : undefined;
        if (isCoverImageTooLarge(coverImageBytes)) {
            if (coverImagePublicId) {
                void destroyAsset(coverImagePublicId).then((result) => {
                    if (!result.ok)
                        console.error('[cloudinary cleanup] failed to delete oversized upload:', result.reason);
                });
            }
            throw new HttpError(400, coverImageTooLargeMessage(coverImageBytes));
        }
        const tickets = Array.isArray(p.tickets) ? p.tickets : [];
        const customFields = Array.isArray(p.customFields) ? p.customFields : [];
        const program = p.program;
        const programItems = Array.isArray(program?.items) ? program.items : [];
        const memoryHub = p.memoryHub;
        await assertEventCreatable(tenantId, {
            ...(p.visibility !== undefined && { visibility: p.visibility }),
            ...(p.ticketing !== undefined && { ticketing: p.ticketing }),
            hasCustomRsvpFields: customFields.length > 0,
        });
        const result = await prisma.$transaction(async (tx) => {
            const event = await tx.event.create({
                data: {
                    tenantId,
                    createdByUserId: userId,
                    name: p.name,
                    description: p.description ?? null,
                    location: p.location,
                    address: p.address ?? null,
                    latitude: latitude ?? null,
                    longitude: longitude ?? null,
                    coverImageUrl: p.coverImageUrl ?? null,
                    coverImagePublicId: coverImagePublicId ?? null,
                    status: 'DRAFT',
                    visibility: p.visibility ?? 'PRIVATE',
                    ticketing: p.ticketing ?? 'FREE',
                    invitationTemplate: p.invitationTemplate ?? null,
                    rsvpDeadline: rsvpDeadline ?? null,
                    capacity: capacity ?? null,
                    isArchived: false,
                    createdBy: userId,
                    updatedBy: userId,
                },
            });
            for (const day of days) {
                await tx.eventDay.create({
                    data: {
                        eventId: event.id,
                        label: day.label,
                        date: new Date(day.date),
                        startTime: day.startTime ? new Date(day.startTime) : null,
                        endTime: day.endTime ? new Date(day.endTime) : null,
                        isArchived: false,
                        createdBy: userId,
                        updatedBy: userId,
                    },
                });
            }
            if (p.ticketing === 'PAID') {
                for (const ticket of tickets) {
                    await tx.ticket.create({
                        data: {
                            eventId: event.id,
                            name: ticket.name,
                            description: ticket.description ?? null,
                            price: ticket.price,
                            currency: ticket.currency ?? 'ZAR',
                            totalQuantity: ticket.totalQuantity ?? null,
                            soldCount: 0,
                            isAvailable: true,
                            isArchived: false,
                            createdBy: userId,
                            updatedBy: userId,
                        },
                    });
                }
            }
            for (const [index, field] of customFields.entries()) {
                await tx.rsvpField.create({
                    data: {
                        eventId: event.id,
                        label: field.label,
                        fieldType: field.fieldType,
                        isRequired: field.isRequired ?? false,
                        options: field.options ? JSON.stringify(field.options) : null,
                        order: index,
                        isArchived: false,
                        createdBy: userId,
                        updatedBy: userId,
                    },
                });
            }
            if (programItems.length > 0) {
                const eventProgram = await tx.eventProgram.create({
                    data: {
                        eventId: event.id,
                        title: program?.title ?? null,
                        isPublished: false,
                        isArchived: false,
                        createdBy: userId,
                        updatedBy: userId,
                    },
                });
                for (const [index, item] of programItems.entries()) {
                    await tx.programItem.create({
                        data: {
                            programId: eventProgram.id,
                            title: item.title,
                            description: item.description ?? null,
                            startTime: new Date(item.startTime),
                            durationMins: item.durationMins ?? null,
                            order: index,
                            isArchived: false,
                            createdBy: userId,
                            updatedBy: userId,
                        },
                    });
                }
            }
            // Every event gets a MemoryHub record on creation; tier-gating on
            // whether it's actually usable happens elsewhere, not at creation time.
            await tx.memoryHub.create({
                data: {
                    eventId: event.id,
                    title: null,
                    description: null,
                    isPublic: false,
                    opensAt: memoryHub?.opensAt ? new Date(memoryHub.opensAt) : null,
                    isArchived: false,
                    createdBy: userId,
                    updatedBy: userId,
                },
            });
            return event;
        });
        // Only delete the draft after the transaction fully succeeds.
        await eventDraftRepository.delete(draft.id);
        return eventRepository.findById(result.id);
    },
};
//# sourceMappingURL=event-draft.service.js.map