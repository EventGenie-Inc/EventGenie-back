import { type CreateUserDto, type UpdateUserDto } from './user.types.js';
export declare const userRepository: {
    findAll: (tenantId?: string) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }[]>;
    findById: (id: string) => import("@prisma/client").Prisma.Prisma__UserClient<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findByFirebaseUid: (firebaseUid: string) => import("@prisma/client").Prisma.Prisma__UserClient<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findByEmail: (email: string) => import("@prisma/client").Prisma.Prisma__UserClient<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findByVendorSpace: (vendorSpaceId: string) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }[]>;
    create: (data: CreateUserDto) => import("@prisma/client").Prisma.Prisma__UserClient<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (id: string, data: UpdateUserDto) => import("@prisma/client").Prisma.Prisma__UserClient<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    archive: (id: string) => import("@prisma/client").Prisma.Prisma__UserClient<{
        id: string;
        email: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string | null;
        vendorSpaceId: string | null;
        firebaseUid: string;
        username: string;
        role: import("@prisma/client").$Enums.PlatformRole;
        isActive: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=user.repository.d.ts.map