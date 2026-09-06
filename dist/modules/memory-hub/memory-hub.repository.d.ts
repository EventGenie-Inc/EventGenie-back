import { type MemoryItemStatus } from '@prisma/client';
import { type CreateMemoryHubDto, type UpdateMemoryHubDto } from './memory-hub.types.js';
export declare const memoryHubRepository: {
    findByEventId: (eventId: string, includeArchived?: boolean) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<({
        memoryItems: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.MemoryItemStatus;
            createdBy: string;
            updatedBy: string;
            bytes: number;
            memoryHubId: string;
            uploadedByGuestId: string | null;
            uploadedByUserId: string | null;
            mediaUrl: string;
            cloudinaryPublicId: string;
            mediaType: import("@prisma/client").$Enums.MediaType;
            caption: string | null;
        }[];
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findById: (id: string, includeArchived?: boolean) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<({
        memoryItems: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.MemoryItemStatus;
            createdBy: string;
            updatedBy: string;
            bytes: number;
            memoryHubId: string;
            uploadedByGuestId: string | null;
            uploadedByUserId: string | null;
            mediaUrl: string;
            cloudinaryPublicId: string;
            mediaType: import("@prisma/client").$Enums.MediaType;
            caption: string | null;
        }[];
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    findByShareToken: (shareToken: string) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<({
        event: {
            eventDays: {
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
            }[];
        } & {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
            createdByUserId: string;
            description: string | null;
            location: string;
            address: string | null;
            latitude: import("@prisma/client-runtime-utils").Decimal | null;
            longitude: import("@prisma/client-runtime-utils").Decimal | null;
            coverImageUrl: string | null;
            coverImagePublicId: string | null;
            status: import("@prisma/client").$Enums.EventStatus;
            visibility: import("@prisma/client").$Enums.EventVisibility;
            ticketing: import("@prisma/client").$Enums.EventTicketing;
            invitationTemplate: string | null;
            invitationConfig: string | null;
            rsvpDeadline: Date | null;
            capacity: number | null;
            createdBy: string;
            updatedBy: string;
        };
        memoryItems: ({
            uploadedByGuest: {
                firstName: string | null;
            } | null;
            uploadedByUser: {
                username: string;
            } | null;
        } & {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.MemoryItemStatus;
            createdBy: string;
            updatedBy: string;
            bytes: number;
            memoryHubId: string;
            uploadedByGuestId: string | null;
            uploadedByUserId: string | null;
            mediaUrl: string;
            cloudinaryPublicId: string;
            mediaType: import("@prisma/client").$Enums.MediaType;
            caption: string | null;
        })[];
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    create: (eventId: string, userId: string, data: CreateMemoryHubDto) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    update: (id: string, userId: string, data: UpdateMemoryHubDto) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    generateShareToken: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    revokeShareToken: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    archive: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    reactivate: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__MemoryHubClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        description: string | null;
        createdBy: string;
        updatedBy: string;
        eventId: string;
        title: string | null;
        isPublic: boolean;
        shareToken: string | null;
        opensAt: Date | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    sumBytesForEvent: (eventId: string) => Promise<number>;
    findAllItems: (memoryHubId: string, status?: MemoryItemStatus, includeArchived?: boolean) => import("@prisma/client").Prisma.PrismaPromise<({
        uploadedByGuest: {
            firstName: string | null;
        } | null;
        uploadedByUser: {
            username: string;
        } | null;
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MemoryItemStatus;
        createdBy: string;
        updatedBy: string;
        bytes: number;
        memoryHubId: string;
        uploadedByGuestId: string | null;
        uploadedByUserId: string | null;
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: import("@prisma/client").$Enums.MediaType;
        caption: string | null;
    })[]>;
    findItemById: (id: string, includeArchived?: boolean) => import("@prisma/client").Prisma.Prisma__MemoryItemClient<({
        uploadedByGuest: {
            firstName: string | null;
        } | null;
        uploadedByUser: {
            username: string;
        } | null;
    } & {
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MemoryItemStatus;
        createdBy: string;
        updatedBy: string;
        bytes: number;
        memoryHubId: string;
        uploadedByGuestId: string | null;
        uploadedByUserId: string | null;
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: import("@prisma/client").$Enums.MediaType;
        caption: string | null;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    createItem: (memoryHubId: string, actorId: string, data: {
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: "IMAGE" | "VIDEO";
        bytes: number;
        caption?: string;
        status: MemoryItemStatus;
        uploadedByUserId?: string;
        uploadedByGuestId?: string;
    }) => import("@prisma/client").Prisma.Prisma__MemoryItemClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MemoryItemStatus;
        createdBy: string;
        updatedBy: string;
        bytes: number;
        memoryHubId: string;
        uploadedByGuestId: string | null;
        uploadedByUserId: string | null;
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: import("@prisma/client").$Enums.MediaType;
        caption: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    updateItemCaption: (id: string, userId: string, caption: string | null | undefined) => import("@prisma/client").Prisma.Prisma__MemoryItemClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MemoryItemStatus;
        createdBy: string;
        updatedBy: string;
        bytes: number;
        memoryHubId: string;
        uploadedByGuestId: string | null;
        uploadedByUserId: string | null;
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: import("@prisma/client").$Enums.MediaType;
        caption: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    updateItemStatus: (id: string, userId: string, status: MemoryItemStatus) => import("@prisma/client").Prisma.Prisma__MemoryItemClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MemoryItemStatus;
        createdBy: string;
        updatedBy: string;
        bytes: number;
        memoryHubId: string;
        uploadedByGuestId: string | null;
        uploadedByUserId: string | null;
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: import("@prisma/client").$Enums.MediaType;
        caption: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    archiveItem: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__MemoryItemClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MemoryItemStatus;
        createdBy: string;
        updatedBy: string;
        bytes: number;
        memoryHubId: string;
        uploadedByGuestId: string | null;
        uploadedByUserId: string | null;
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: import("@prisma/client").$Enums.MediaType;
        caption: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    reactivateItem: (id: string, userId: string) => import("@prisma/client").Prisma.Prisma__MemoryItemClient<{
        id: string;
        isArchived: boolean;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MemoryItemStatus;
        createdBy: string;
        updatedBy: string;
        bytes: number;
        memoryHubId: string;
        uploadedByGuestId: string | null;
        uploadedByUserId: string | null;
        mediaUrl: string;
        cloudinaryPublicId: string;
        mediaType: import("@prisma/client").$Enums.MediaType;
        caption: string | null;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=memory-hub.repository.d.ts.map