import prisma from '../../shared/prisma/prisma.client.js';
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
    findById: (id) => prisma.event.findFirst({
        where: { id, isArchived: false },
        include: {
            eventDays: { where: { isArchived: false } },
            memoryHub: true,
        },
    }),
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
            ...(data.status !== undefined && { status: data.status }),
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
};
//# sourceMappingURL=event.repository.js.map