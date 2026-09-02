import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';
import { type PlatformRole } from '@prisma/client';
export declare const eventDayService: {
    getAll: (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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
    getById: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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
    create: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateEventDayDto) => Promise<{
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
    update: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDayDto) => Promise<{
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
    archive: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
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