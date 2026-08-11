export declare const attendanceService: {
    getAll: (inviteId: string) => import("@prisma/client").Prisma.PrismaPromise<({
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
    getById: (id: string) => Promise<{
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
    }>;
    create: (inviteId: string, eventDayId: string) => import("@prisma/client").Prisma.Prisma__AttendanceClient<{
        id: string;
        inviteId: string;
        eventDayId: string;
        confirmedAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    delete: (id: string) => Promise<{
        id: string;
        inviteId: string;
        eventDayId: string;
        confirmedAt: Date;
    }>;
};
//# sourceMappingURL=attendance.service.d.ts.map