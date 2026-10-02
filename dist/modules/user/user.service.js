import { userRepository } from './user.repository.js';
import {} from './user.types.js';
import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { suspendFirebaseAccount, reactivateFirebaseAccount, } from '../../shared/firebase/firebase-account-status.util.js';
import { revokeAllDeviceTokensForUser, REVOKE_REASON } from '../auth/device-token.util.js';
import { resolveTenantScope, isTenantScopeEmptyForList } from '../../shared/utils/tenant-scope.util.js';
const ROLES_ASSIGNABLE_BY_TENANT_ADMIN = ['TENANT_ADMIN', 'EVENT_ADMIN', 'EVENT_VENDOR'];
// TENANT_ADMIN and EVENT_ADMIN are operationally tenant-scoped everywhere
// (requireTenantAdmin/requireEventAdmin, and now tenant-scope.util.ts's
// resolveTenantScope) — a user with either role and no tenantId is
// exactly the "should never exist" state Security Sweep Before G3's Fix 1
// made getById/getAll fail closed against. SUPER_ADMIN is deliberately
// platform-wide (no tenant of its own); EVENT_VENDOR is deliberately
// scoped by VendorSpaceUser membership, not tenantId (a platform-level
// vendor space has none either — see vendor.service.ts's header comment).
// Neither belongs in this list.
const ROLES_REQUIRING_TENANT = ['TENANT_ADMIN', 'EVENT_ADMIN'];
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
        // A non-SUPER_ADMIN with no tenantId should never exist — fail closed
        // with an empty list rather than an unscoped, every-tenant query. See
        // tenant-scope.util.ts.
        if (isTenantScopeEmptyForList(requestingRole, tenantId))
            return Promise.resolve([]);
        return userRepository.findAll(tenantId ?? undefined);
    },
    // requestingRole/tenantId scope the lookup to the caller's own tenant;
    // SUPER_ADMIN bypasses, matching the pattern already used by
    // eventService.getById. Thrown as HttpError so cross-tenant access
    // surfaces as 404, not a generic 500.
    getById: async (id, requestingRole, tenantId, includeArchived = false) => {
        const scope = resolveTenantScope(requestingRole, tenantId, 'User not found');
        const user = await userRepository.findById(id, includeArchived, scope);
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
        // Valid shape (a real role, a real requester), unsatisfied
        // precondition (that role needs a tenant and none was given) — 422,
        // per STEERING's status table, not 400. A TENANT_ADMIN creating one
        // of these always supplies requesterTenantId (their own), so this
        // fires only for a misconfigured requester or a SUPER_ADMIN who
        // omitted tenantId — exactly the state Fix 1 made getById/getAll
        // fail closed against; this stops it being created in the first place.
        if (ROLES_REQUIRING_TENANT.includes(data.role) && !resolvedTenantId) {
            throw new HttpError(422, `A ${data.role} must belong to a tenant — specify tenantId.`);
        }
        // EVENT_VENDOR users are no longer linked to a space at creation —
        // vendor-space membership is many-to-many now (VendorSpaceUser) and
        // is assigned separately afterward, via vendorService.assignVendorUser.
        const existing = await userRepository.findByEmail(data.email);
        if (existing)
            throw new Error('A user with this email already exists');
        return userRepository.create({
            firebaseUid: data.firebaseUid,
            email: data.email,
            username: data.username,
            role: data.role,
            ...(resolvedTenantId !== undefined && { tenantId: resolvedTenantId }),
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
        // Trusted Devices — exchangeSession's own isActive/isArchived check
        // already blocks a suspended user regardless of device-token state,
        // so this isn't what makes suspension effective immediately. It
        // matters for what happens AFTER: without this, a device trusted
        // before the suspension would silently still be trusted the moment
        // the user is reactivated — no fresh 2FA, no record anything
        // happened in between. Revoking here means reactivation always
        // starts from zero trusted devices.
        await revokeAllDeviceTokensForUser(id, REVOKE_REASON.USER_SUSPENDED);
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