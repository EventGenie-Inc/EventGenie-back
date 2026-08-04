import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from './rsvp-field.types.js';
export declare const rsvpFieldRepository: {
    findAll: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        label: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }[]>;
    findById: (id: string) => import("@prisma/client").Prisma.Prisma__RsvpFieldClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        label: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    create: (eventId: string, userId: string, data: CreateRsvpFieldDto) => import("@prisma/client").Prisma.Prisma__RsvpFieldClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        label: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (id: string, userId: string, data: UpdateRsvpFieldDto) => import("@prisma/client").Prisma.Prisma__RsvpFieldClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        label: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    archive: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__RsvpFieldClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        label: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=rsvp-field.repository.d.ts.map