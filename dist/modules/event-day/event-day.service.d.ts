import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';
export declare const eventDayService: {
    getAll: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<{
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
    getById: (id: string) => Promise<{
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
    }>;
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
    update: (id: string, userId: string, data: UpdateEventDayDto) => Promise<{
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
    }>;
    archive: (id: string, userId: string) => Promise<{
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
    }>;
};
//# sourceMappingURL=event-day.service.d.ts.map