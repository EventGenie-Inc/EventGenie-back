import { type UpdateGuestDto } from './guest.types.js';
export interface CreateGuestWithInviteInput {
    firstName: string | null;
    surname: string | null;
    email: string | null;
    phoneNumber: string | null;
    eventDayIds: string[];
}
export declare const guestRepository: {
    findById: (id: string, includeArchived?: boolean, tenantId?: string) => import("@prisma/client").Prisma.Prisma__GuestClient<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findAll: (tenantId?: string, includeArchived?: boolean) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
    }[]>;
    findAllForEvent: (eventId: string, includeArchived?: boolean) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
    }[]>;
    findContactsForEvent: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string | null;
        phoneNumber: string | null;
    }[]>;
    countForEvent: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<number>;
    createWithInvite: (eventId: string, userId: string, data: CreateGuestWithInviteInput) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
    }>;
    bulkCreateWithInvites: (eventId: string, userId: string, rows: {
        firstName: string | null;
        surname: string | null;
        email: string | null;
        phoneNumber: string | null;
        eventDayIds: string[];
    }[]) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
    }[]>;
    update: (id: string, data: UpdateGuestDto) => import("@prisma/client").Prisma.Prisma__GuestClient<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=guest.repository.d.ts.map