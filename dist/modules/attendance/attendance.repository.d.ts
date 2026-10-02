import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const attendanceRepository: {
    findAll: (inviteId: string) => Prisma.PrismaPromise<({
        eventDay: {
            label: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            location: string | null;
            address: string | null;
            latitude: Prisma.Decimal | null;
            longitude: Prisma.Decimal | null;
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
    })[]>;
    findById: (id: string) => Prisma.Prisma__AttendanceClient<({
        eventDay: {
            label: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            location: string | null;
            address: string | null;
            latitude: Prisma.Decimal | null;
            longitude: Prisma.Decimal | null;
            createdBy: string;
            updatedBy: string;
            eventId: string;
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
        };
    } & {
        id: string;
        inviteId: string;
        confirmedAt: Date;
        eventDayId: string;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    create: (inviteId: string, eventDayId: string, db?: Db) => Prisma.Prisma__AttendanceClient<{
        id: string;
        inviteId: string;
        confirmedAt: Date;
        eventDayId: string;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    delete: (id: string) => Prisma.Prisma__AttendanceClient<{
        id: string;
        inviteId: string;
        confirmedAt: Date;
        eventDayId: string;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
export {};
//# sourceMappingURL=attendance.repository.d.ts.map