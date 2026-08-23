import { userRepository } from './user.repository.js';
import {} from './user.types.js';
import {} from '@prisma/client';
import { suspendFirebaseAccount, reactivateFirebaseAccount, } from '../../shared/firebase/firebase-account-status.util.js';
export const userService = {
    getAll: (requestingRole, tenantId) => {
        // SUPER_ADMIN sees all users, including suspended ones — the Super
        // Admin must always be able to see and restore suspended entities.
        // Other roles are unaffected: tenant-scoped, active users only.
        if (requestingRole === 'SUPER_ADMIN')
            return userRepository.findAll(undefined, true);
        return userRepository.findAll(tenantId ?? undefined);
    },
    getById: async (id, includeArchived = false) => {
        const user = await userRepository.findById(id, includeArchived);
        if (!user)
            throw new Error('User not found');
        return user;
    },
    create: async (data) => {
        if (data.role === 'EVENT_VENDOR' && !data.vendorSpaceId) {
            throw new Error('vendorSpaceId is required when creating an EVENT_VENDOR user');
        }
        const existing = await userRepository.findByEmail(data.email);
        if (existing)
            throw new Error('A user with this email already exists');
        return userRepository.create(data);
    },
    update: async (id, data) => {
        await userService.getById(id);
        return userRepository.update(id, data);
    },
    archive: async (id) => {
        const user = await userService.getById(id);
        const archived = await userRepository.archive(id);
        await suspendFirebaseAccount(user.firebaseUid);
        return archived;
    },
    reactivate: async (id) => {
        // Must look up including archived — the whole point of reactivate is
        // to find a user that is currently archived and un-archive them.
        const user = await userService.getById(id, true);
        const reactivated = await userRepository.reactivate(id);
        await reactivateFirebaseAccount(user.firebaseUid);
        return reactivated;
    },
};
//# sourceMappingURL=user.service.js.map