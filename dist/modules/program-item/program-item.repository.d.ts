import { type CreateProgramItemDto, type UpdateProgramItemDto } from './program-item.types.js';
export declare const programItemRepository: {
    findAll: (programId: string) => import("@prisma/client").Prisma.PrismaPromise<{
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
    findById: (id: string) => import("@prisma/client").Prisma.Prisma__ProgramItemClient<{
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
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
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
    update: (id: string, userId: string, data: UpdateProgramItemDto) => import("@prisma/client").Prisma.Prisma__ProgramItemClient<{
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
    archive: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__ProgramItemClient<{
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
};
//# sourceMappingURL=program-item.repository.d.ts.map