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
    create: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateInviteDto) => Promise<{
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
    update: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateInviteDto) => Promise<{
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
    archive: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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
    reactivate: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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