import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';
export declare const inviteRepository: {
    findAll: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<({
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
    findById: (id: string) => import("@prisma/client").Prisma.Prisma__InviteClient<({
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
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findByToken: (token: string) => import("@prisma/client").Prisma.Prisma__InviteClient<({
        event: {
            eventDays: {
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
            }[];
            rsvpFields: {
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
                eventId: string;
                label: string;
                fieldType: import("@prisma/client").$Enums.RsvpFieldType;
                isRequired: boolean;
                options: string | null;
                order: number;
            }[];
            tickets: {
                name: string;
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                description: string | null;
                createdBy: string;
                updatedBy: string;
                eventId: string;
                price: import("@prisma/client-runtime-utils").Decimal;
                currency: string;
                totalQuantity: number | null;
                soldCount: number;
                isAvailable: boolean;
            }[];
        } & {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            createdByUserId: string;
            description: string | null;
            location: string;
            address: string | null;
            latitude: import("@prisma/client-runtime-utils").Decimal | null;
            longitude: import("@prisma/client-runtime-utils").Decimal | null;
            coverImageUrl: string | null;
            status: import("@prisma/client").$Enums.EventStatus;
            visibility: import("@prisma/client").$Enums.EventVisibility;
            ticketing: import("@prisma/client").$Enums.EventTicketing;
            invitationTemplate: string | null;
            invitationConfig: string | null;
            createdBy: string;
            updatedBy: string;
        };
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
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
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
    update: (id: string, userId: string, data: UpdateInviteDto) => import("@prisma/client").Prisma.Prisma__InviteClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    archive: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__InviteClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=invite.repository.d.ts.map