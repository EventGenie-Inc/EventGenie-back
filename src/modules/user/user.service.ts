import { userRepository } from './user.repository.js';
import { type CreateUserDto, type UpdateUserDto } from './user.types.js';
import { type PlatformRole } from '@prisma/client';

export const userService = {

  getAll: (requestingRole: PlatformRole, tenantId: string | null) => {
    // SUPER_ADMIN sees all users, others see only their tenant
    if (requestingRole === 'SUPER_ADMIN') return userRepository.findAll();
    return userRepository.findAll(tenantId ?? undefined);
  },

  getById: async (id: string) => {
    const user = await userRepository.findById(id);
    if (!user) throw new Error('User not found');
    return user;
  },

  create: async (data: CreateUserDto) => {
    const existing = await userRepository.findByEmail(data.email);
    if (existing) throw new Error('A user with this email already exists');
    return userRepository.create(data);
  },

  update: async (id: string, data: UpdateUserDto) => {
    await userService.getById(id);
    return userRepository.update(id, data);
  },

  archive: async (id: string) => {
    await userService.getById(id);
    return userRepository.archive(id);
  },
};