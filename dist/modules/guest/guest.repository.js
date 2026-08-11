import prisma from '../../shared/prisma/prisma.client.js';
import {} from './guest.types.js';
export const guestRepository = {
    findAll: () => prisma.guest.findMany({ where: { isArchived: false }, orderBy: { createdAt: 'desc' } }),
    findById: (id) => prisma.guest.findFirst({ where: { id, isArchived: false } }),
    findByEmail: (email) => prisma.guest.findFirst({ where: { email, isArchived: false } }),
    create: (data) => prisma.guest.create({
        data: { ...data, isArchived: false },
    }),
    update: (id, data) => prisma.guest.update({ where: { id }, data }),
    archive: (id) => prisma.guest.update({ where: { id }, data: { isArchived: true } }),
};
//# sourceMappingURL=guest.repository.js.map