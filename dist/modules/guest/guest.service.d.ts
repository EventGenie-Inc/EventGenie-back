import { type CreateGuestDto, type UpdateGuestDto } from './guest.types.js';
export declare const guestService: {
    getAll: () => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        firstName: string;
        surname: string;
    }[]>;
    getById: (id: string) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        firstName: string;
        surname: string;
    }>;
    create: (data: CreateGuestDto) => import("@prisma/client").Prisma.Prisma__GuestClient<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        firstName: string;
        surname: string;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (id: string, data: UpdateGuestDto) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        firstName: string;
        surname: string;
    }>;
    archive: (id: string) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        firstName: string;
        surname: string;
    }>;
};
//# sourceMappingURL=guest.service.d.ts.map