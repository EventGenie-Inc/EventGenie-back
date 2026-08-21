import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import {} from './event-draft.types.js';
export const eventDraftRepository = {
    findByTenantAndUser: (tenantId, userId) => prisma.eventDraft.findUnique({
        where: { tenantId_createdByUserId: { tenantId, createdByUserId: userId } },
    }),
    findById: (id) => prisma.eventDraft.findUnique({ where: { id } }),
    upsert: (tenantId, userId, data) => prisma.eventDraft.upsert({
        where: { tenantId_createdByUserId: { tenantId, createdByUserId: userId } },
        create: {
            tenantId,
            createdByUserId: userId,
            currentStep: data.currentStep,
            payload: data.payload,
        },
        update: {
            currentStep: data.currentStep,
            payload: data.payload,
        },
    }),
    delete: (id) => prisma.eventDraft.delete({ where: { id } }),
};
//# sourceMappingURL=event-draft.repository.js.map