import { type CreateEventProgramDto, type UpdateEventProgramDto } from './event-program.types.js';
export declare const eventProgramService: {
    getByEventId: (eventId: string) => Promise<{
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
    getById: (id: string) => Promise<{
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
    create: (eventId: string, userId: string, data: CreateEventProgramDto) => Promise<{
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
    update: (id: string, userId: string, data: UpdateEventProgramDto) => Promise<{
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
    archive: (id: string, userId: string) => Promise<{
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
};
//# sourceMappingURL=event-program.service.d.ts.map