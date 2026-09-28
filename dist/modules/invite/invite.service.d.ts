import { type CreateInviteDto, type UpdateInviteDto } from './invite.types.js';
import { type PlatformRole } from '@prisma/client';
export declare const inviteService: {
    getAll: (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<({
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
        inviteEventDay: ({
            eventDay: {
                label: string;
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
                eventId: string;
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
        eventId: string;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        expiresAt: Date | null;
        usedAt: Date | null;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveredAt: Date | null;
        lastRemindedAt: Date | null;
    })[]>;
    getById: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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
        inviteEventDay: ({
            eventDay: {
                label: string;
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
                eventId: string;
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
                label: string;
                id: string;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
                eventId: string;
                date: Date;
                startTime: Date | null;
                endTime: Date | null;
            };
        } & {
            id: string;
            inviteId: string;
            confirmedAt: Date;
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
        eventId: string;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        expiresAt: Date | null;
        usedAt: Date | null;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveredAt: Date | null;
        lastRemindedAt: Date | null;
    }>;
    create: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateInviteDto) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        expiresAt: Date | null;
        usedAt: Date | null;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveredAt: Date | null;
        lastRemindedAt: Date | null;
    }>;
    update: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateInviteDto) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        expiresAt: Date | null;
        usedAt: Date | null;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveredAt: Date | null;
        lastRemindedAt: Date | null;
    }>;
    archive: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        expiresAt: Date | null;
        usedAt: Date | null;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveredAt: Date | null;
        lastRemindedAt: Date | null;
    }>;
    reactivate: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.InviteStatus;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
        expiresAt: Date | null;
        usedAt: Date | null;
        guestId: string;
        token: string;
        used: boolean;
        editToken: string | null;
        editTokenExpiresAt: Date | null;
        deliveredAt: Date | null;
        lastRemindedAt: Date | null;
    }>;
};
//# sourceMappingURL=invite.service.d.ts.map