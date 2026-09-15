import { type CreateGuestDto, type UpdateGuestDto } from './guest.types.js';
import { type PlatformRole } from '@prisma/client';
export declare const guestService: {
    getAll: (requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    }[]>;
    getById: (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    }>;
    getAllForEvent: (eventId: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived?: boolean) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    }[]>;
    create: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateGuestDto) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    }>;
    update: (id: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateGuestDto) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    }>;
    archive: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    } | null>;
    reactivate: (id: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        id: string;
        email: string | null;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        phoneNumber: string | null;
        eventId: string;
        firstName: string | null;
        surname: string | null;
        hostGuestId: string | null;
        plusOnesAllowed: number;
    } | null>;
    getImportTemplate: (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        buffer: Buffer;
        filename: string;
    }>;
    importGuests: (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, file: {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
    }) => Promise<{
        totalRows: number;
        created: number;
        failed: number;
        failures: import("./guest-import.engine.js").ImportRowFailure[];
    }>;
    exportGuests: (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => Promise<{
        buffer: Buffer;
        filename: string;
    }>;
};
//# sourceMappingURL=guest.service.d.ts.map