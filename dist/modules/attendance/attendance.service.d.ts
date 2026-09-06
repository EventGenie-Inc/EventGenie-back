import { type PlatformRole } from '@prisma/client';
export declare const attendanceService: {
    getAll: (inviteId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<({
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
    })[]>;
    getById: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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
    } & {
        id: string;
        inviteId: string;
        eventDayId: string;
        confirmedAt: Date;
    }>;
    create: (inviteId: string, eventDayId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        inviteId: string;
        eventDayId: string;
        confirmedAt: Date;
    }>;
    delete: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        inviteId: string;
        eventDayId: string;
        confirmedAt: Date;
    }>;
};
//# sourceMappingURL=attendance.service.d.ts.map