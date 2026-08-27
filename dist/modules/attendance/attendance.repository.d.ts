import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const attendanceRepository: {
    findAll: (inviteId: string) => Prisma.PrismaPromise<({
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
    findById: (id: string) => Prisma.Prisma__AttendanceClient<({
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
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    create: (inviteId: string, eventDayId: string, db?: Db) => Prisma.Prisma__AttendanceClient<{
        id: string;
        inviteId: string;
        eventDayId: string;
        confirmedAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    delete: (id: string) => Prisma.Prisma__AttendanceClient<{
        id: string;
        inviteId: string;
        eventDayId: string;
        confirmedAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
export {};
//# sourceMappingURL=attendance.repository.d.ts.map