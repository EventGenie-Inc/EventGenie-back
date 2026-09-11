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
        } | null;
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
            inviteId: string;
            currency: string;
            ticketId: string;
            quantity: number;
            totalPaid: import("@prisma/client-runtime-utils").Decimal;
            paymentRef: string | null;
            purchasedAt: Date;
        } | null;
        refundNotice: string | null;
    }>;
};
//# sourceMappingURL=rsvp.service.d.ts.map