import { userRepository } from './user.repository.js';
import { type CreateUserDto, type UpdateUserDto } from './user.types.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  suspendFirebaseAccount,
  reactivateFirebaseAccount,
} from '../../shared/firebase/firebase-account-status.util.js';

export const userService = {

  getAll: (requestingRole: PlatformRole, tenantId: string | null) => {
    // SUPER_ADMIN sees all users, including suspended ones — the Super
    // Admin must always be able to see and restore suspended entities.
    // Other roles are unaffected: tenant-scoped, active users only.
    if (requestingRole === 'SUPER_ADMIN') return userRepository.findAll(undefined, true);
    return userRepository.findAll(tenantId ?? undefined);
  },

  // requestingRole/tenantId scope the lookup to the caller's own tenant;
  // SUPER_ADMIN bypasses, matching the pattern already used by
  // eventService.getById. Thrown as HttpError so cross-tenant access
  // surfaces as 404, not a generic 500.
  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    const user = requestingRole === 'SUPER_ADMIN'
      ? await userRepository.findById(id, includeArchived)
      : await userRepository.findById(id, includeArchived, tenantId ?? undefined);

    if (!user) throw new HttpError(404, 'User not found');
    return user;
  },

  create: async (data: CreateUserDto) => {
    if (data.role === 'EVENT_VENDOR' && !data.vendorSpaceId) {
      throw new Error('vendorSpaceId is required when creating an EVENT_VENDOR user');
    }
    const existing = await userRepository.findByEmail(data.email);
    if (existing) throw new Error('A user with this email already exists');
    return userRepository.create(data);
  },

  update: async (id: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateUserDto) => {
    await userService.getById(id, requestingRole, tenantId);
    return userRepository.update(id, data);
  },

  archive: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const user = await userService.getById(id, requestingRole, tenantId);
    const archived = await userRepository.archive(id);
    await suspendFirebaseAccount(user.firebaseUid);
    return archived;
  },

  reactivate: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // Must look up including archived — the whole point of reactivate is
    // to find a user that is currently archived and un-archive them.
    const user = await userService.getById(id, requestingRole, tenantId, true);
    const reactivated = await userRepository.reactivate(id);
    await reactivateFirebaseAccount(user.firebaseUid);
    return reactivated;
  },
};