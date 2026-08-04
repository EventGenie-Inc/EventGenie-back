import prisma from '../../shared/prisma/prisma.client.js';
import {} from './invite.types.js';
import crypto from 'crypto';
export const inviteRepository = {
    findAll: (eventId) => prisma.invite.findMany({
        where: { eventId, isArchived: false },
        include: { guest: true, inviteEventDay: { include: { eventDay: true } } },
        orderBy: { createdAt: 'desc' },
    }),
    findById: (id) => prisma.invite.findFirst({
        where: { id, isArchived: false },
        include: {
            guest: true,
            inviteEventDay: { include: { eventDay: true } },
            attendances: { include: { eventDay: true } },
        },
    }),
    findByToken: (token) => prisma.invite.findUnique({
        where: { token },
        include: {
            guest: true,
            inviteEventDay: { include: { eventDay: true } },
            event: {
                include: {
                    eventDays: { where: { isArchived: false } },
                    rsvpFields: { where: { isArchived: false }, orderBy: { order: 'asc' } },
                    tickets: { where: { isArchived: false, isAvailable: true } },
                },
            },
        },
    }),
    create: (eventId, userId, data) => prisma.$transaction(async (tx) => {
        const invite = await tx.invite.create({
            data: {
                eventId,
                guestId: data.guestId,
                token: crypto.randomBytes(32).toString('hex'),
                status: 'PENDING',
                used: false,
                deliveryMethod: data.deliveryMethod,
                // Optional fields must be null (not undefined) for exactOptionalPropertyTypes
                expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
                isArchived: false,
                createdBy: userId,
                updatedBy: userId,
            },
        });
        await tx.inviteEventDay.createMany({
            data: data.invitedDayIds.map((eventDayId) => ({
                inviteId: invite.id,
                eventDayId,
            })),
        });
        return invite;
    }),
    update: (id, userId, data) => prisma.invite.update({
        where: { id },
        data: {
            ...(data.status !== undefined && { status: data.status }),
            ...(data.deliveryMethod !== undefined && { deliveryMethod: data.deliveryMethod }),
            // For nullable DateTime: explicitly set null or the Date value
            ...(data.expiresAt !== undefined && {
                expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
            }),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.invite.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
};
//# sourceMappingURL=invite.repository.js.map