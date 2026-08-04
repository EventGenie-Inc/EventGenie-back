import { type CreateEventProgramDto, type UpdateEventProgramDto } from './event-program.types.js';
export declare const eventProgramRepository: {
    findByEventId: (eventId: string) => import("@prisma/client").Prisma.Prisma__EventProgramClient<({
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
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findById: (id: string) => import("@prisma/client").Prisma.Prisma__EventProgramClient<({
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
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    create: (eventId: string, userId: string, data: CreateEventProgramDto) => import("@prisma/client").Prisma.Prisma__EventProgramClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (id: string, userId: string, data: UpdateEventProgramDto) => import("@prisma/client").Prisma.Prisma__EventProgramClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    archive: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__EventProgramClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublished: boolean;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=event-program.repository.d.ts.map