import { type CreateUserDto, type UpdateUserDto } from './user.types.js';
import { type PlatformRole } from '@prisma/client';
export declare const userService: {
    getAll: (requestingRole: PlatformRole, tenantId: string | null) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }[]>;
    getById: (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }>;
    create: (requestingRole: PlatformRole, requesterId: string, requesterTenantId: string | null, data: CreateUserDto) => Promise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }>;
    update: (id: string, requestingRole: PlatformRole, tenantId: string | null, requesterId: string, data: UpdateUserDto) => Promise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }>;
    archive: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }>;
    reactivate: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }>;
};
//# sourceMappingURL=user.service.d.ts.map