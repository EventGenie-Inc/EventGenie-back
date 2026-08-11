import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';
export declare const eventDayRepository: {
    findAll: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<{
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
    }[]>;
    findById: (id: string) => import("@prisma/client").Prisma.Prisma__EventDayClient<{
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
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    create: (eventId: string, userId: string, data: CreateEventDayDto) => import("@prisma/client").Prisma.Prisma__EventDayClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (id: string, userId: string, data: UpdateEventDayDto) => import("@prisma/client").Prisma.Prisma__EventDayClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    archive: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__EventDayClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=event-day.repository.d.ts.map