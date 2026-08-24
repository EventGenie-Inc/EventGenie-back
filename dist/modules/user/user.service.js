import { userRepository } from './user.repository.js';
import {} from './user.types.js';
import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { suspendFirebaseAccount, reactivateFirebaseAccount, } from '../../shared/firebase/firebase-account-status.util.js';
const ROLES_ASSIGNABLE_BY_TENANT_ADMIN = ['TENANT_ADMIN', 'EVENT_ADMIN', 'EVENT_VENDOR'];
const assertMayAssignRole = (input) => {
    const { requesterRole, requesterId, newRole, targetId, targetCurrentRole } = input;
    // Rule: nobody may change their own role, regardless of role — including
    // SUPER_ADMIN. This is the escalation vector that matters most.
    if (targetId !== undefined && requesterId === targetId) {
        throw new HttpError(403, 'You cannot change your own role.');
    }
    // Rule: a SUPER_ADMIN's role may only be changed by another SUPER_ADMIN.
    if (targetCurrentRole === 'SUPER_ADMIN' && requesterRole !== 'SUPER_ADMIN') {
        throw new HttpError(403, "Only a SUPER_ADMIN may change another SUPER_ADMIN's role.");
    }
    if (requesterRole === 'SUPER_ADMIN')
        return; // may assign any role
    if (requesterRole === 'TENANT_ADMIN') {
        if (!ROLES_ASSIGNABLE_BY_TENANT_ADMIN.includes(newRole)) {
            throw new HttpError(403, `TENANT_ADMIN cannot assign the ${newRole} role.`);
        }
        return;
    }
    // Defense in depth — EVENT_ADMIN/EVENT_VENDOR are already blocked from
    // reaching this router at all by requireTenantAdmin, so this should be
    // unreachable via HTTP, but never fall through to an implicit allow.
    throw new HttpError(403, 'You do not have permission to assign roles.');
};
export const userService = {
    getAll: (requestingRole, tenantId) => {
        // SUPER_ADMIN sees all users, including suspended ones — the Super
        // Admin must always be able to see and restore suspended entities.
        // Other roles are unaffected: tenant-scoped, active users only.
        if (requestingRole === 'SUPER_ADMIN')
            return userRepository.findAll(undefined, true);
        return userRepository.findAll(tenantId ?? undefined);
    },
    // requestingRole/tenantId scope the lookup to the caller's own tenant;
    // SUPER_ADMIN bypasses, matching the pattern already used by
    // eventService.getById. Thrown as HttpError so cross-tenant access
    // surfaces as 404, not a generic 500.
    getById: async (id, requestingRole, tenantId, includeArchived = false) => {
        const user = requestingRole === 'SUPER_ADMIN'
            ? await userRepository.findById(id, includeArchived)
            : await userRepository.findById(id, includeArchived, tenantId ?? undefined);
        if (!user)
            throw new HttpError(404, 'User not found');
        return user;
    },
    create: async (requestingRole, requesterId, requesterTenantId, data) => {
        assertMayAssignRole({ requesterRole: requestingRole, requesterId, newRole: data.role });
        // TENANT_ADMIN: tenantId is forced to the requester's own tenant —
        // data.tenantId is never read on this path, not merely overwritten
        // after validation. SUPER_ADMIN: may specify any tenantId (or none,
        // for the SUPER_ADMIN shape).
        const resolvedTenantId = requestingRole === 'SUPER_ADMIN' ? data.tenantId : (requesterTenantId ?? undefined);
        if (data.role === 'EVENT_VENDOR' && !data.vendorSpaceId) {
            throw new Error('vendorSpaceId is required when creating an EVENT_VENDOR user');
        }
        const existing = await userRepository.findByEmail(data.email);
        if (existing)
            throw new Error('A user with this email already exists');
        return userRepository.create({
            firebaseUid: data.firebaseUid,
            email: data.email,
            username: data.username,
            role: data.role,
            ...(resolvedTenantId !== undefined && { tenantId: resolvedTenantId }),
            ...(data.vendorSpaceId !== undefined && { vendorSpaceId: data.vendorSpaceId }),
        });
    },
    update: async (id, requestingRole, tenantId, requesterId, data) => {
        const target = await userService.getById(id, requestingRole, tenantId);
        if (data.role !== undefined) {
            assertMayAssignRole({
                requesterRole: requestingRole,
                requesterId,
                newRole: data.role,
                targetId: id,
                targetCurrentRole: target.role,
            });
        }
        return userRepository.update(id, data);
    },
    archive: async (id, requestingRole, tenantId) => {
        const user = await userService.getById(id, requestingRole, tenantId);
        const archived = await userRepository.archive(id);
        await suspendFirebaseAccount(user.firebaseUid);
        return archived;
    },
    reactivate: async (id, requestingRole, tenantId) => {
        // Must look up including archived — the whole point of reactivate is
        // to find a user that is currently archived and un-archive them.
        const user = await userService.getById(id, requestingRole, tenantId, true);
        const reactivated = await userRepository.reactivate(id);
        await reactivateFirebaseAccount(user.firebaseUid);
        return reactivated;
    },
};
//# sourceMappingURL=user.service.js.map