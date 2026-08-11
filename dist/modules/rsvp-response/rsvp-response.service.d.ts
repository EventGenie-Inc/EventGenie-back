export declare const rsvpResponseService: {
    getAll: (inviteId: string) => import("@prisma/client").Prisma.PrismaPromise<({
        rsvpField: {
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
        };
    } & {
        id: string;
        createdAt: Date;
        inviteId: string;
        rsvpFieldId: string;
        value: string;
    })[]>;
    getById: (id: string) => Promise<{
        rsvpField: {
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
        };
    } & {
        id: string;
        createdAt: Date;
        inviteId: string;
        rsvpFieldId: string;
        value: string;
    }>;
};
//# sourceMappingURL=rsvp-response.service.d.ts.map