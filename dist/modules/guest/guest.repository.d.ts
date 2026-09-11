import { type UpdateGuestDto } from './guest.types.js';
export interface CreateGuestWithInviteInput {
    firstName: string | null;
    surname: string | null;
    email: string | null;
    phoneNumber: string | null;
    eventDayIds: string[];
    plusOnesAllowed: number;
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
        hostGuestId: string | null;
        plusOnesAllowed: number;
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
        hostGuestId: string | null;
        plusOnesAllowed: number;
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
        hostGuestId: string | null;
        plusOnesAllowed: number;
    }[]>;
    findContactsForEvent: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string | null;
        phoneNumber: string | null;
    }[]>;
    countForEvent: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<number>;
    findAllForExport: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<({
        invites: ({
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
            attendances: {
                id: string;
                inviteId: string;
                eventDayId: string;
                confirmedAt: Date;
            }[];
            rsvpResponses: {
                id: string;
                createdAt: Date;
                inviteId: string;
                rsvpFieldId: string;
                value: string;
            }[];
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
        })[];
        hostGuest: {
            firstName: string | null;
            surname: string | null;
        } | null;
    } & {
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    })[]>;
    createWithInvite: (eventId: string, userId: string, data: CreateGuestWithInviteInput) => Promise<{
        guest: {
            id: string;
            email: string | null;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            phoneNumber: string | null;
            eventId: string;
            firstName: string | null;
            surname: string | null;
            hostGuestId: string | null;
            plusOnesAllowed: number;
        };
        invite: {
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
        };
    }>;
    bulkCreateWithInvites: (eventId: string, userId: string, rows: {
        firstName: string | null;
        surname: string | null;
        email: string | null;
        phoneNumber: string | null;
        eventDayIds: string[];
        plusOnesAllowed: number;
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
        hostGuestId: string | null;
        plusOnesAllowed: number;
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
        hostGuestId: string | null;
        plusOnesAllowed: number;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=guest.repository.d.ts.map