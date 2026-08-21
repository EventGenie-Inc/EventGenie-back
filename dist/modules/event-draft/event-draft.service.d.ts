import { type UpsertEventDraftDto } from './event-draft.types.js';
export declare const eventDraftService: {
    getCurrentDraft: (tenantId: string, userId: string) => import("@prisma/client").Prisma.Prisma__EventDraftClient<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        currentStep: number;
        payload: import("@prisma/client/runtime/client").JsonValue;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    saveDraft: (tenantId: string, userId: string, data: UpsertEventDraftDto) => import("@prisma/client").Prisma.Prisma__EventDraftClient<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        currentStep: number;
        payload: import("@prisma/client/runtime/client").JsonValue;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, import("@prisma/client").Prisma.PrismaClientOptions>;
    discardDraft: (tenantId: string, userId: string) => Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        currentStep: number;
        payload: import("@prisma/client/runtime/client").JsonValue;
    }>;
    materialize: (tenantId: string, userId: string) => Promise<({
        memoryHub: {
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
        } | null;
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
        rsvpFields: {
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
        }[];
        program: ({
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
        }) | null;
        tickets: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            price: import("@prisma/client-runtime-utils").Decimal;
            currency: string;
            totalQuantity: number | null;
            soldCount: number;
            isAvailable: boolean;
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
        status: import("@prisma/client").$Enums.EventStatus;
        visibility: import("@prisma/client").$Enums.EventVisibility;
        ticketing: import("@prisma/client").$Enums.EventTicketing;
        invitationTemplate: string | null;
        invitationConfig: string | null;
        createdBy: string;
        updatedBy: string;
    }) | null>;
};
//# sourceMappingURL=event-draft.service.d.ts.map