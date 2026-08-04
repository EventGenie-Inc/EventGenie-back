import prisma from '../../shared/prisma/prisma.client.js';
import {} from './memory-hub.types.js';
import crypto from 'crypto';
export const memoryHubRepository = {
    // ── Memory Hub ────────────────────────────
    findByEventId: (eventId) => prisma.memoryHub.findFirst({
        where: { eventId, isArchived: false },
        include: {
            memoryItems: {
                where: { isArchived: false },
                orderBy: { createdAt: 'desc' },
            },
        },
    }),
    findById: (id) => prisma.memoryHub.findFirst({
        where: { id, isArchived: false },
        include: {
            memoryItems: {
                where: { isArchived: false },
                orderBy: { createdAt: 'desc' },
            },
        },
    }),
    findByShareToken: (shareToken) => prisma.memoryHub.findFirst({
        where: { shareToken, isArchived: false },
        include: {
            event: true,
            memoryItems: {
                where: { isArchived: false, isApproved: true },
                orderBy: { createdAt: 'desc' },
            },
        },
    }),
    create: (eventId, userId, data) => prisma.memoryHub.create({
        data: {
            eventId,
            title: data.title ?? null,
            description: data.description ?? null,
            isPublic: false,
            shareToken: null,
            opensAt: data.opensAt ? new Date(data.opensAt) : null,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    update: (id, userId, data) => prisma.memoryHub.update({
        where: { id },
        data: {
            ...(data.title !== undefined && { title: data.title ?? null }),
            ...(data.description !== undefined && { description: data.description ?? null }),
            ...(data.isPublic !== undefined && { isPublic: data.isPublic }),
            ...(data.opensAt !== undefined && { opensAt: data.opensAt ? new Date(data.opensAt) : null }),
            updatedBy: userId,
        },
    }),
    // Generate a public share token when hub is made public
    generateShareToken: (id, userId) => prisma.memoryHub.update({
        where: { id },
        data: {
            isPublic: true,
            shareToken: crypto.randomBytes(24).toString('hex'),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.memoryHub.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    // ── Memory Items ──────────────────────────
    findAllItems: (memoryHubId) => prisma.memoryItem.findMany({
        where: { memoryHubId, isArchived: false },
        orderBy: { createdAt: 'desc' },
    }),
    findItemById: (id) => prisma.memoryItem.findFirst({
        where: { id, isArchived: false },
    }),
    createItem: (memoryHubId, userId, data) => prisma.memoryItem.create({
        data: {
            memoryHubId,
            mediaUrl: data.mediaUrl,
            mediaType: data.mediaType,
            caption: data.caption ?? null,
            uploadedByGuestId: data.uploadedByGuestId ?? null,
            uploadedByUserId: data.uploadedByUserId ?? null,
            isApproved: false,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    updateItem: (id, userId, data) => prisma.memoryItem.update({
        where: { id },
        data: {
            ...(data.caption !== undefined && { caption: data.caption ?? null }),
            ...(data.isApproved !== undefined && { isApproved: data.isApproved }),
            updatedBy: userId,
        },
    }),
    archiveItem: (id, userId) => prisma.memoryItem.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
};
//# sourceMappingURL=memory-hub.repository.js.map