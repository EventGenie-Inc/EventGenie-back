import prisma from '../../shared/prisma/prisma.client.js';
import { tenantRepository } from './tenant.repository.js';
import { suspendFirebaseAccount, reactivateFirebaseAccount, } from '../../shared/firebase/firebase-account-status.util.js';
export const tenantService = {
    getAll: () => tenantRepository.findAll(),
    getById: async (id) => {
        const tenant = await tenantRepository.findById(id);
        if (!tenant)
            throw new Error('Tenant not found');
        return tenant;
    },
    getUsers: async (id) => {
        await tenantService.getById(id);
        return tenantRepository.findAllUsersByTenant(id);
    },
    // Locks out the entire tenant and cascades to archiving every
    // User under it. Reversible via reactivate — Super Admin never
    // deletes data.
    suspend: async (id, superAdminUserId) => {
        await tenantService.getById(id);
        const users = await tenantRepository.findAllUsersByTenant(id);
        await prisma.$transaction(async (tx) => {
            await tx.tenant.update({
                where: { id },
                data: { subscriptionStatus: 'SUSPENDED' },
            });
            for (const user of users) {
                await tx.user.update({
                    where: { id: user.id },
                    data: { isArchived: true, isActive: false },
                });
            }
        });
        for (const user of users) {
            await suspendFirebaseAccount(user.firebaseUid);
        }
        return tenantRepository.findById(id);
    },
    reactivate: async (id, superAdminUserId) => {
        await tenantService.getById(id);
        // Per the agreed v1 approach, this uniformly reactivates all
        // users under the tenant, including any that may have been
        // individually suspended before the tenant-wide suspension.
        // A future version could track suspension origin (individual
        // vs cascade) to preserve individual suspensions through a
        // tenant reactivation — out of scope for v1.
        const users = await prisma.user.findMany({
            where: { tenantId: id, isArchived: true },
        });
        await prisma.$transaction(async (tx) => {
            await tx.tenant.update({
                where: { id },
                data: { subscriptionStatus: 'ACTIVE' },
            });
            for (const user of users) {
                await tx.user.update({
                    where: { id: user.id },
                    data: { isArchived: false, isActive: true },
                });
            }
        });
        for (const user of users) {
            await reactivateFirebaseAccount(user.firebaseUid);
        }
        return tenantRepository.findById(id);
    },
};
//# sourceMappingURL=tenant.service.js.map