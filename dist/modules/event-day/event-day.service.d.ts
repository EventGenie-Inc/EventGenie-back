import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';
import { type PlatformRole } from '@prisma/client';
export declare const eventDayService: {
    getAll: (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<(Omit<{
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
    getById: (id: string, eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<Omit<{
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
    create: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateEventDayDto) => Promise<Omit<{
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
    update: (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDayDto) => Promise<Omit<{
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
    archive: (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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
    }>;
};
//# sourceMappingURL=event-day.service.d.ts.map