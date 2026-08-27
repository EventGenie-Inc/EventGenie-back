import { type SubmitRsvpDto } from './rsvp.types.js';
export declare const rsvpService: {
    validate: (token: string) => Promise<{
        invite: {
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
            };
            guest: {
                id: string;
                email: string | null;
                isArchived: boolean;
                createdAt: Date;
                updatedAt: Date;
                phoneNumber: string | null;
                eventId: string;
                firstName: string | null;
                surname: string | null;
            };
            inviteEventDay: ({
                eventDay: {
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
                };
            } & {
                id: string;
                createdAt: Date;
                inviteId: string;
                eventDayId: string;
            })[];
        } & {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.InviteStatus;
            createdBy: string;
            updatedBy: string;
            expiresAt: Date | null;
            usedAt: Date | null;
            eventId: string;
            guestId: string;
            token: string;
            used: boolean;
            editToken: string | null;
            editTokenExpiresAt: Date | null;
            deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
            deliveredAt: Date | null;
        };
        isExpired: boolean;
        isUsed: boolean;
    }>;
    submit: (data: SubmitRsvpDto) => Promise<{
        invite: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.InviteStatus;
            createdBy: string;
            updatedBy: string;
            expiresAt: Date | null;
            usedAt: Date | null;
            eventId: string;
            guestId: string;
            token: string;
            used: boolean;
            editToken: string | null;
            editTokenExpiresAt: Date | null;
            deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
            deliveredAt: Date | null;
        };
        attendances: {
            id: string;
            inviteId: string;
            eventDayId: string;
            confirmedAt: Date;
        }[];
        rsvpResponses: {
            id: string;
            createdAt: Date;
            inviteId: string;
            rsvpFieldId: string;
            value: string;
        }[];
        ticketPurchase: {
            id: string;
            inviteId: string;
            currency: string;
            ticketId: string;
            quantity: number;
            totalPaid: import("@prisma/client-runtime-utils").Decimal;
            paymentRef: string | null;
            purchasedAt: Date;
        } | null;
    }>;
};
//# sourceMappingURL=rsvp.service.d.ts.map