import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from './rsvp-field.types.js';
export declare const rsvpFieldService: {
    getAll: (eventId: string) => import("@prisma/client").Prisma.PrismaPromise<{
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
    getById: (id: string) => Promise<{
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
    }>;
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
    update: (id: string, userId: string, data: UpdateRsvpFieldDto) => Promise<{
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
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }>;
};
//# sourceMappingURL=rsvp-field.service.d.ts.map