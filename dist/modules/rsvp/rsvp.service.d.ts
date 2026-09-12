import { type EventStatus } from '@prisma/client';
import { type SubmitRsvpDto } from './rsvp.types.js';
export declare const RSVP_BLOCK_MESSAGES: Partial<Record<EventStatus, string>>;
export declare const rsvpService: {
    validate: (token: string) => Promise<{
        invite: {
            token: string;
            status: import("@prisma/client").$Enums.InviteStatus;
            expiresAt: Date | null;
            guest: {
                firstName: string | null;
                surname: string | null;
                email: string | null;
                phoneNumber: string | null;
                plusOnesAllowed: number;
            };
            inviteEventDay: {
                eventDay: {
                    id: string;
                    label: string;
                    date: Date;
                    startTime: Date | null;
                    endTime: Date | null;
                };
            }[];
            event: {
                name: string;
                description: string | null;
                hostName: string | null;
                location: string;
                address: string | null;
                coverImageUrl: string | null;
                rsvpDeadline: Date | null;
                status: import("@prisma/client").$Enums.EventStatus;
                ticketing: import("@prisma/client").$Enums.EventTicketing;
                ticketsRefundable: boolean;
                rsvpFields: {
                    id: string;
                    label: string;
                    fieldType: import("@prisma/client").$Enums.RsvpFieldType;
                    isRequired: boolean;
                    options: string | null;
                }[];
                tickets: {
                    id: string;
                    name: string;
                    price: import("@prisma/client-runtime-utils").Decimal;
                    currency: string;
                }[];
            };
        };
        isExpired: boolean;
        isUsed: boolean;
        isRsvpDeadlinePassed: boolean;
        attendingDayIds: string[];
        rsvpResponses: {
            rsvpFieldId: string;
            value: string;
        }[];
        plusOneNames: (string | null)[];
        ticketPurchase: {
            ticketId: string;
            quantity: number;
            totalPaid: import("@prisma/client-runtime-utils").Decimal;
            currency: string;
            status: import("@prisma/client").$Enums.TicketPurchaseStatus;
        } | null;
    }>;
    submit: (data: SubmitRsvpDto) => Promise<{
        paymentAction: null;
        invite: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.InviteStatus;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            expiresAt: Date | null;
            usedAt: Date | null;
            guestId: string;
            token: string;
            used: boolean;
            editToken: string | null;
            editTokenExpiresAt: Date | null;
            deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
            deliveredAt: Date | null;
        };
        attendances: {
            inviteId: string;
            eventDayId: string;
        }[];
        rsvpResponses: {
            inviteId: string;
            rsvpFieldId: string;
            value: string;
        }[];
        ticketPurchase: {
            id: string;
            status: import("@prisma/client").$Enums.TicketPurchaseStatus;
            inviteId: string;
            currency: string;
            confirmedAt: Date | null;
            ticketId: string;
            quantity: number;
            totalPaid: import("@prisma/client-runtime-utils").Decimal;
            ticketPriceCents: number;
            commissionCents: number;
            paymentRef: string | null;
            holdExpiresAt: Date | null;
            purchasedAt: Date;
        } | {
            id: string;
            ticketId: string;
            inviteId: string;
            quantity: number;
            status: string;
        } | null;
        refundNotice: string | null;
    } | {
        paymentAction: {
            type: "retry_needed";
            reason: string;
            authorizationUrl?: never;
        };
        invite: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.InviteStatus;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            expiresAt: Date | null;
            usedAt: Date | null;
            guestId: string;
            token: string;
            used: boolean;
            editToken: string | null;
            editTokenExpiresAt: Date | null;
            deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
            deliveredAt: Date | null;
        };
        attendances: {
            inviteId: string;
            eventDayId: string;
        }[];
        rsvpResponses: {
            inviteId: string;
            rsvpFieldId: string;
            value: string;
        }[];
        ticketPurchase: {
            id: string;
            status: import("@prisma/client").$Enums.TicketPurchaseStatus;
            inviteId: string;
            currency: string;
            confirmedAt: Date | null;
            ticketId: string;
            quantity: number;
            totalPaid: import("@prisma/client-runtime-utils").Decimal;
            ticketPriceCents: number;
            commissionCents: number;
            paymentRef: string | null;
            holdExpiresAt: Date | null;
            purchasedAt: Date;
        } | {
            id: string;
            ticketId: string;
            inviteId: string;
            quantity: number;
            status: string;
        } | null;
        refundNotice: string | null;
    } | {
        paymentAction: {
            type: "redirect";
            authorizationUrl: string;
            reason?: never;
        };
        invite: {
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.InviteStatus;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            expiresAt: Date | null;
            usedAt: Date | null;
            guestId: string;
            token: string;
            used: boolean;
            editToken: string | null;
            editTokenExpiresAt: Date | null;
            deliveryMethod: import("@prisma/client").$Enums.DeliveryMethod;
            deliveredAt: Date | null;
        };
        attendances: {
            inviteId: string;
            eventDayId: string;
        }[];
        rsvpResponses: {
            inviteId: string;
            rsvpFieldId: string;
            value: string;
        }[];
        ticketPurchase: {
            id: string;
            status: import("@prisma/client").$Enums.TicketPurchaseStatus;
            inviteId: string;
            currency: string;
            confirmedAt: Date | null;
            ticketId: string;
            quantity: number;
            totalPaid: import("@prisma/client-runtime-utils").Decimal;
            ticketPriceCents: number;
            commissionCents: number;
            paymentRef: string | null;
            holdExpiresAt: Date | null;
            purchasedAt: Date;
        } | {
            id: string;
            ticketId: string;
            inviteId: string;
            quantity: number;
            status: string;
        } | null;
        refundNotice: string | null;
    }>;
    retryTicketPayment: (token: string) => Promise<{
        status: "PENDING" | "PAID";
        authorizationUrl: null;
        reason?: never;
    } | {
        status: "FAILED";
        authorizationUrl: null;
        reason: string;
    } | {
        status: "RETRYING";
        authorizationUrl: string;
        reason?: never;
    }>;
    confirmTicketPayment: (token: string) => Promise<{
        status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
    }>;
};
//# sourceMappingURL=rsvp.service.d.ts.map