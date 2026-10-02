import prisma from '../../shared/prisma/prisma.client.js';
import { eventDraftRepository } from './event-draft.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import {} from './event-draft.types.js';
import {} from '@prisma/client';
import { assertEventCreatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { requireDayLabel, requireDayDate } from '../event-day/event-day-validation.util.js';
import { resolveDayVenueForCreate } from '../event-day/event-day-venue.util.js';
import { requireTicketName, requireTicketPrice } from '../ticket/ticket-validation.util.js';
import { requireFieldLabel, requireFieldType } from '../rsvp-field/rsvp-field-validation.util.js';
import { requireItemTitle, requireItemStartTime } from '../program-item/program-item-validation.util.js';
import { assertValidRsvpDeadline } from '../event/event-rsvp-deadline.util.js';
import { assertValidCapacity } from '../event/event-capacity.util.js';
import { isCoverImageTooLarge, coverImageTooLargeMessage, assertCoverPublicIdOwned } from '../event/event-cover-image.util.js';
import { destroyAsset } from '../../shared/cloudinary/cloudinary.client.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';
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
        // 422, the same status and words the direct endpoints use — each
        // required field is checked by the SAME helper the matching endpoint
        // calls (event name here; days, tickets, custom fields and program
        // items below), so the wizard can't save what an edit would refuse.
        // No event-level venue any more: it belongs to each day.
        if (typeof p.name !== 'string' || !p.name.trim()) {
            throw new HttpError(422, 'Your event needs a name.');
        }
        const eventName = p.name.trim();
        if (!Array.isArray(p.days) || p.days.length === 0) {
            throw new HttpError(422, 'Your event needs at least one day.');
        }
        const days = p.days.map((day) => {
            const label = requireDayLabel(day.label);
            return {
                label,
                date: requireDayDate(day.date, label),
                startTime: day.startTime ? parseClientDateTime(day.startTime) : null,
                endTime: day.endTime ? parseClientDateTime(day.endTime) : null,
                venue: resolveDayVenueForCreate(day, label),
            };
        });
        // Duplicate day labels within this draft would make the import
        // engine's Day-column matching ambiguous later — checked purely
        // in-memory, before the transaction starts, since the event doesn't
        // exist yet and there's nothing external to race against. Matches
        // event-day-validation.util.ts's case-insensitive rule.
        const seenLabels = new Set();
        for (const day of days) {
            const label = day.label.toLowerCase();
            if (seenLabels.has(label)) {
                throw new HttpError(409, `Duplicate day label '${day.label}' — day labels must be unique within an event`);
            }
            seenLabels.add(label);
        }
        // Same both-or-neither/plausibility treatment extended to the two
        // Batch A fields — the wizard is the primary event-creation path, so
        // leaving these validated only on the direct POST would make the
        // deadline/capacity feature unreachable from real event creation.
        const capacity = p.capacity !== undefined && p.capacity !== null ? Number(p.capacity) : undefined;
        assertValidCapacity(capacity);
        const rsvpDeadline = p.rsvpDeadline !== undefined && p.rsvpDeadline !== null ? parseClientDateTime(p.rsvpDeadline) : undefined;
        assertValidRsvpDeadline(rsvpDeadline ?? null, days, { rejectPast: true });
        // Same size-limit + cleanup-of-the-already-uploaded-file treatment as
        // the direct POST path (event.service.ts) — see event-cover-image.util.ts
        // for why this can only be checked here, after Cloudinary has already
        // reported the file's size back to the frontend.
        const coverImagePublicId = typeof p.coverImagePublicId === 'string' ? p.coverImagePublicId : undefined;
        const coverImageBytes = typeof p.coverImageBytes === 'number' ? p.coverImageBytes : undefined;
        // Ownership first: the size rejection below destroys the asset, and the
        // id is stored on the new event (see assertCoverPublicIdOwned).
        assertCoverPublicIdOwned(tenantId, coverImagePublicId);
        if (isCoverImageTooLarge(coverImageBytes)) {
            if (coverImagePublicId) {
                void destroyAsset(coverImagePublicId).then((result) => {
                    if (!result.ok)
                        console.error('[cloudinary cleanup] failed to delete oversized upload:', result.reason);
                });
            }
            throw new HttpError(400, coverImageTooLargeMessage(coverImageBytes));
        }
        const tickets = (Array.isArray(p.tickets) ? p.tickets : []).map((ticket) => {
            const name = requireTicketName(ticket.name);
            return { ...ticket, name, price: requireTicketPrice(ticket.price, name) };
        });
        const customFields = (Array.isArray(p.customFields) ? p.customFields : []).map((field) => {
            const label = requireFieldLabel(field.label);
            return { ...field, label, fieldType: requireFieldType(field.fieldType, label) };
        });
        const program = p.program;
        const programItems = (Array.isArray(program?.items) ? program.items : []).map((item) => {
            const title = requireItemTitle(item.title);
            return { ...item, title, startTime: requireItemStartTime(item.startTime, title) };
        });
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
                    name: eventName,
                    description: p.description ?? null,
                    coverImageUrl: p.coverImageUrl ?? null,
                    coverImagePublicId: coverImagePublicId ?? null,
                    status: 'DRAFT',
                    visibility: p.visibility ?? 'PRIVATE',
                    ticketing: p.ticketing ?? 'FREE',
                    // Shown to guests as the host line; an empty one means no host line.
                    hostName: typeof p.hostName === 'string' && p.hostName.trim() ? p.hostName.trim() : null,
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
                        date: day.date,
                        startTime: day.startTime,
                        endTime: day.endTime,
                        location: day.venue.location,
                        address: day.venue.address,
                        latitude: day.venue.latitude,
                        longitude: day.venue.longitude,
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
                        // Visible to guests by default, same as event-program.repository.ts.
                        isPublished: true,
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
                            startTime: item.startTime,
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
                    opensAt: memoryHub?.opensAt ? parseClientDateTime(memoryHub.opensAt) : null,
                    isArchived: false,
                    createdBy: userId,
                    updatedBy: userId,
                },
            });
            return event;
        }, {
            // Task 0 (Subscription Billing batch) audit: found with neither
            // timeout nor maxWait set. This materializes a whole wizard draft
            // in sequential per-row loops (days, tickets, custom RSVP fields,
            // program items) — unbounded by any of those counts, the same
            // shape of bug bulkCreateWithInvites and rsvp.service.ts's
            // transaction already hit at real row counts. A draft with a
            // multi-day program and a long custom-field list is a realistic
            // way to exceed Prisma's defaults (~2s connection acquisition,
            // ~5s execution) well before touching Neon's own cold-start cost.
            maxWait: 10000,
            timeout: 15000,
        });
        // Only delete the draft after the transaction fully succeeds.
        await eventDraftRepository.delete(draft.id);
        return eventRepository.findById(result.id);
    },
};
//# sourceMappingURL=event-draft.service.js.map