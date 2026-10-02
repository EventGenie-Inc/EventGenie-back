import { type PlatformRole } from '@prisma/client';
import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from './rsvp-field.types.js';
export declare const rsvpFieldService: {
    getAll: (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }[]>;
    getById: (id: string, eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }>;
    create: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateRsvpFieldDto) => Promise<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }>;
    update: (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateRsvpFieldDto) => Promise<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }>;
    archive: (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        label: string;
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        fieldType: import("@prisma/client").$Enums.RsvpFieldType;
        isRequired: boolean;
        options: string | null;
        order: number;
    }>;
};
//# sourceMappingURL=rsvp-field.service.d.ts.map