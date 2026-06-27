import prisma from '../../shared/prisma/prisma.client.js';
import { type CreateUserDto, type UpdateUserDto } from './user.types.js';

export const userRepository = {

  findAll: (tenantId?: string) =>
    prisma.user.findMany({
      where: {
        isArchived: false,
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    }),

  findById: (id: string) =>
    prisma.user.findFirst({
      where: { id, isArchived: false },
    }),

  findByFirebaseUid: (firebaseUid: string) =>
    prisma.user.findUnique({
      where: { firebaseUid },
    }),

  findByEmail: (email: string) =>
    prisma.user.findFirst({
      where: { email, isArchived: false },
    }),

  create: (data: CreateUserDto) =>
    prisma.user.create({
      data: {
        firebaseUid: data.firebaseUid,
        email: data.email,
        username: data.username,
        role: data.role,
        tenantId: data.tenantId ?? null,
        isActive: true,
        isArchived: false,
      },
    }),

  update: (id: string, data: UpdateUserDto) =>
    prisma.user.update({
      where: { id },
      data: { ...data, updatedAt: new Date() },
    }),

  archive: (id: string) =>
    prisma.user.update({
      where: { id },
      data: { isArchived: true, isActive: false },
    }),
};