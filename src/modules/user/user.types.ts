import { type PlatformRole } from '@prisma/client';

export interface CreateUserDto {
  firebaseUid: string;
  email: string;
  username: string;
  role: PlatformRole;
  tenantId?: string;
}

export interface UpdateUserDto {
  username?: string;
  role?: PlatformRole;
  isActive?: boolean;
}