import { type PlatformRole } from '@prisma/client';
import { type CreateEventProgramDto, type UpdateEventProgramDto } from './event-program.types.js';
export declare const eventProgramService: {
    getByEventId: (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        programItems: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            startTime: Date;
            order: number;
            title: string;
            programId: string;
            eventDayId: string | null;
            durationMins: number | null;
        }[];
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }>;
    getById: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        programItems: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            startTime: Date;
            order: number;
            title: string;
            programId: string;
            eventDayId: string | null;
            durationMins: number | null;
        }[];
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }>;
    create: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateEventProgramDto) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }>;
    update: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventProgramDto) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }>;
    archive: (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }>;
    getProgramForInvite: (token: unknown) => Promise<{
        available: false;
        title?: never;
        days?: never;
    } | {
        available: true;
        title: string | null;
        days: {
            eventDayId: string;
            label: string;
            date: Date;
            items: {
                id: string;
                title: string;
                description: string | null;
                startTime: Date;
                durationMins: number | null;
            }[];
        }[];
    }>;
};
//# sourceMappingURL=event-program.service.d.ts.map