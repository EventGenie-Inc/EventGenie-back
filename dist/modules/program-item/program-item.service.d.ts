import { type CreateProgramItemDto, type UpdateProgramItemDto } from './program-item.types.js';
export declare const programItemService: {
    getAll: (programId: string) => import("@prisma/client").Prisma.PrismaPromise<{
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
    }[]>;
    getById: (id: string) => Promise<{
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
    }>;
    create: (programId: string, userId: string, data: CreateProgramItemDto) => import("@prisma/client").Prisma.Prisma__ProgramItemClient<{
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
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (id: string, userId: string, data: UpdateProgramItemDto) => Promise<{
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
    }>;
    archive: (id: string, userId: string) => Promise<{
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
    }>;
};
//# sourceMappingURL=program-item.service.d.ts.map