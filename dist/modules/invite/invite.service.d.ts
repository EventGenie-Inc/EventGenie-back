import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';
export declare const inviteService: {
    getAll: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<({
        guest: {
            id: string;
            email: string | null;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            phoneNumber: string | null;
            firstName: string;
            surname: string;
        };
        inviteEventDay: ({
            eventDay: {
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
                eventId: string;
                label: string;
                date: Date;
                startTime: Date | null;
                endTime: Date | null;
            };
        } & {
            id: string;
            createdAt: Date;
            inviteId: string;
            eventDayId: string;
        })[];
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        expiresAt: Date | null;
        usedAt: Date | null;
        eventId: string;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        deliveredAt: Date | null;
    })[]>;
    getById: (id: string) => Promise<{
        guest: {
            id: string;
            email: string | null;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            phoneNumber: string | null;
            firstName: string;
            surname: string;
        };
        inviteEventDay: ({
            eventDay: {
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
                eventId: string;
                label: string;
                date: Date;
                startTime: Date | null;
                endTime: Date | null;
            };
        } & {
            id: string;
            createdAt: Date;
            inviteId: string;
            eventDayId: string;
        })[];
        attendances: ({
            eventDay: {
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
                eventId: string;
                label: string;
                date: Date;
                startTime: Date | null;
                endTime: Date | null;
            };
        } & {
            id: string;
            inviteId: string;
            eventDayId: string;
            confirmedAt: Date;
        })[];
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        expiresAt: Date | null;
        usedAt: Date | null;
        eventId: string;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        deliveredAt: Date | null;
    }>;
    create: (eventId: string, userId: string, data: CreateInviteDto) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        expiresAt: Date | null;
        usedAt: Date | null;
        eventId: string;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        deliveredAt: Date | null;
    }>;
    update: (id: string, userId: string, data: UpdateInviteDto) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        expiresAt: Date | null;
        usedAt: Date | null;
        eventId: string;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        deliveredAt: Date | null;
    }>;
    archive: (id: string, userId: string) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        expiresAt: Date | null;
        usedAt: Date | null;
        eventId: string;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        deliveredAt: Date | null;
    }>;
};
//# sourceMappingURL=invite.service.d.ts.map