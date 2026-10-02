import { type DayVenue } from './event-day-venue.util.js';
export interface EventDayWrite {
    label: string;
    date: Date;
    startTime: Date | null;
    endTime: Date | null;
    venue: DayVenue;
}
export interface EventDayPatch {
    label?: string;
    date?: Date;
    startTime?: Date | null;
    endTime?: Date | null;
    venue: DayVenue;
}
export declare const eventDayRepository: {
    findAll: (eventId: string) => Promise<(Omit<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        location: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal | null;
        longitude: import("@prisma/client-runtime-utils").Decimal | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        date: Date;
        startTime: Date | null;
        endTime: Date | null;
    }, "latitude" | "longitude"> & {
        latitude: number | null;
        longitude: number | null;
    })[]>;
    findById: (id: string) => Promise<(Omit<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        location: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal | null;
        longitude: import("@prisma/client-runtime-utils").Decimal | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        date: Date;
        startTime: Date | null;
        endTime: Date | null;
    }, "latitude" | "longitude"> & {
        latitude: number | null;
        longitude: number | null;
    }) | null>;
    create: (eventId: string, userId: string, data: EventDayWrite) => Promise<Omit<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        location: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal | null;
        longitude: import("@prisma/client-runtime-utils").Decimal | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        date: Date;
        startTime: Date | null;
        endTime: Date | null;
    }, "latitude" | "longitude"> & {
        latitude: number | null;
        longitude: number | null;
    }>;
    update: (id: string, userId: string, data: EventDayPatch) => Promise<Omit<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        location: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal | null;
        longitude: import("@prisma/client-runtime-utils").Decimal | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        date: Date;
        startTime: Date | null;
        endTime: Date | null;
    }, "latitude" | "longitude"> & {
        latitude: number | null;
        longitude: number | null;
    }>;
    archive: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__EventDayClient<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        location: string | null;
        address: string | null;
        latitude: import("@prisma/client-runtime-utils").Decimal | null;
        longitude: import("@prisma/client-runtime-utils").Decimal | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        date: Date;
        startTime: Date | null;
        endTime: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=event-day.repository.d.ts.map