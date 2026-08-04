import prisma from '../../shared/prisma/prisma.client.js';
import {} from './user.types.js';
export const userRepository = {
    findAll: (tenantId) => prisma.user.findMany({
        where: {
            isArchived: false,
            ...(tenantId ? { tenantId } : {}),
        },
        orderBy: { createdAt: 'desc' },
    }),
    findById: (id) => prisma.user.findFirst({
        where: { id, isArchived: false },
    }),
    findByFirebaseUid: (firebaseUid) => prisma.user.findUnique({
        where: { firebaseUid },
    }),
    findByEmail: (email) => prisma.user.findFirst({
        where: { email, isArchived: false },
    }),
    findByVendorSpace: (vendorSpaceId) => prisma.user.findMany({
        where: { vendorSpaceId, isArchived: false },
        orderBy: { createdAt: 'desc' },
    }),
    create: (data) => prisma.user.create({
        data: {
            firebaseUid: data.firebaseUid,
            email: data.email,
            username: data.username,
            role: data.role,
            tenantId: data.tenantId ?? null,
            vendorSpaceId: data.vendorSpaceId ?? null,
            isActive: true,
            isArchived: false,
        },
    }),
    update: (id, data) => prisma.user.update({
        where: { id },
        data: { ...data, updatedAt: new Date() },
    }),
    archive: (id) => prisma.user.update({
        where: { id },
        data: { isArchived: true, isActive: false },
    }),
};
//# sourceMappingURL=user.repository.js.map