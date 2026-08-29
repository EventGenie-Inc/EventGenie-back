import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import {} from './event.types.js';
export const eventRepository = {
    findAll: (tenantId) => prisma.event.findMany({
        where: {
            isArchived: false,
            ...(tenantId ? { tenantId } : {}),
        },
        include: { eventDays: { where: { isArchived: false } } },
        orderBy: { createdAt: 'desc' },
    }),
    findById: (id, tenantId) => prisma.event.findFirst({
        where: {
            id,
            isArchived: false,
            ...(tenantId ? { tenantId } : {}),
        },
        include: {
            eventDays: { where: { isArchived: false } },
            memoryHub: true,
            tickets: { where: { isArchived: false } },
            rsvpFields: { where: { isArchived: false }, orderBy: { order: 'asc' } },
            program: {
                include: {
                    programItems: { where: { isArchived: false }, orderBy: { order: 'asc' } },
                },
            },
        },
    }),
    countActive: (tenantId) => prisma.event.count({ where: { tenantId, isArchived: false } }),
    create: (tenantId, userId, data) => prisma.event.create({
        data: {
            tenantId,
            createdByUserId: userId,
            name: data.name,
            // Optional fields must be null (not undefined) for exactOptionalPropertyTypes
            description: data.description ?? null,
            location: data.location,
            address: data.address ?? null,
            latitude: data.latitude ?? null,
            longitude: data.longitude ?? null,
            coverImageUrl: data.coverImageUrl ?? null,
            status: 'DRAFT',
            visibility: data.visibility ?? 'PRIVATE',
            ticketing: data.ticketing ?? 'FREE',
            invitationTemplate: data.invitationTemplate ?? null,
            invitationConfig: data.invitationConfig ?? null,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    update: (id, userId, data) => prisma.event.update({
        where: { id },
        data: {
            // Only include fields that are explicitly provided
            ...(data.name !== undefined && { name: data.name }),
            ...(data.description !== undefined && { description: data.description ?? null }),
            ...(data.location !== undefined && { location: data.location }),
            ...(data.address !== undefined && { address: data.address ?? null }),
            ...(data.latitude !== undefined && { latitude: data.latitude ?? null }),
            ...(data.longitude !== undefined && { longitude: data.longitude ?? null }),
            ...(data.coverImageUrl !== undefined && { coverImageUrl: data.coverImageUrl ?? null }),
            ...(data.visibility !== undefined && { visibility: data.visibility }),
            ...(data.ticketing !== undefined && { ticketing: data.ticketing }),
            ...(data.invitationTemplate !== undefined && { invitationTemplate: data.invitationTemplate ?? null }),
            ...(data.invitationConfig !== undefined && { invitationConfig: data.invitationConfig ?? null }),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.event.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    // The only writer of Event.status — publish() and cancel() in
    // event.service.ts are the sole callers. Kept separate from the
    // generic update() above (which no longer accepts a status field at
    // all) so a status transition can never be smuggled through a plain
    // PUT /api/events/:id alongside unrelated field edits.
    updateStatus: (id, userId, status) => prisma.event.update({
        where: { id },
        data: { status, updatedBy: userId },
    }),
};
//# sourceMappingURL=event.repository.js.map