import { type Prisma } from '@prisma/client';
export interface ReserveTicketPurchaseInput {
    tenantId: string;
    eventId: string;
    inviteId: string;
    ticket: {
        id: string;
        price: Prisma.Decimal;
        currency: string;
    };
    quantity: number;
}
export interface ReservedPurchase {
    purchaseId: string;
    paymentRef: string;
    totalChargeCents: number;
    platformChargeCents: number;
    subaccountCode: string;
}
export interface StartCheckoutInput {
    paymentRef: string;
    totalChargeCents: number;
    platformChargeCents: number;
    guestEmail: string;
    subaccountCode: string;
    callbackUrl: string;
}
export type CheckoutResult = {
    authorizationUrl: string;
} | {
    failed: true;
    reason: string;
};
export interface RetryPaymentInput {
    purchaseId: string;
    ticketId: string;
    ticketPrice: Prisma.Decimal;
    currency: string;
    quantity: number;
    tenantId: string;
}
export interface TicketQuote {
    ticketPriceCents: number;
    commissionCents: number;
    processingFeeCents: number;
    totalChargeCents: number;
    currency: string;
}
export declare const ticketPurchaseService: {
    quote: (ticket: {
        price: Prisma.Decimal;
        currency: string;
    }, quantity: number) => TicketQuote;
    getAll: (inviteId: string) => Prisma.PrismaPromise<({
        ticket: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            currency: string;
            price: Prisma.Decimal;
            totalQuantity: number | null;
            soldCount: number;
            heldCount: number;
            isAvailable: boolean;
        };
    } & {
        id: string;
        status: import("@prisma/client").$Enums.TicketPurchaseStatus;
        inviteId: string;
        currency: string;
        paymentRef: string | null;
        confirmedAt: Date | null;
        purchasedAt: Date;
        ticketId: string;
        quantity: number;
        totalPaid: Prisma.Decimal;
        ticketPriceCents: number;
        commissionCents: number;
        holdExpiresAt: Date | null;
    })[]>;
    getById: (id: string) => Promise<{
        ticket: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            currency: string;
            price: Prisma.Decimal;
            totalQuantity: number | null;
            soldCount: number;
            heldCount: number;
            isAvailable: boolean;
        };
    } & {
        id: string;
        status: import("@prisma/client").$Enums.TicketPurchaseStatus;
        inviteId: string;
        currency: string;
        paymentRef: string | null;
        confirmedAt: Date | null;
        purchasedAt: Date;
        ticketId: string;
        quantity: number;
        totalPaid: Prisma.Decimal;
        ticketPriceCents: number;
        commissionCents: number;
        holdExpiresAt: Date | null;
    }>;
    getAllForEvent: (eventId: string) => Prisma.PrismaPromise<({
        invite: {
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
                hostGuestId: string | null;
                plusOnesAllowed: number;
            };
        } & {
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
        ticket: {
            name: string;
            id: string;
            isArchived: boolean;
            createdAt: Date;
            updatedAt: Date;
            description: string | null;
            createdBy: string;
            updatedBy: string;
            eventId: string;
            currency: string;
            price: Prisma.Decimal;
            totalQuantity: number | null;
            soldCount: number;
            heldCount: number;
            isAvailable: boolean;
        };
    } & {
        id: string;
        status: import("@prisma/client").$Enums.TicketPurchaseStatus;
        inviteId: string;
        currency: string;
        paymentRef: string | null;
        confirmedAt: Date | null;
        purchasedAt: Date;
        ticketId: string;
        quantity: number;
        totalPaid: Prisma.Decimal;
        ticketPriceCents: number;
        commissionCents: number;
        holdExpiresAt: Date | null;
    })[]>;
    reserveWithinTransaction: (tx: Prisma.TransactionClient, input: ReserveTicketPurchaseInput) => Promise<ReservedPurchase>;
    startPaystackCheckout: (params: StartCheckoutInput) => Promise<CheckoutResult>;
    retryPayment: (input: RetryPaymentInput) => Promise<{
        status: "PAID" | "PENDING";
    } | {
        status: "RETRYING";
        paymentRef: string;
        totalChargeCents: number;
        platformChargeCents: number;
        subaccountCode: string;
    }>;
    reconcile: (purchaseId: string) => Promise<{
        status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
    }>;
    confirmPaymentWithinTransaction: (tx: Prisma.TransactionClient, paymentRef: string, providerPayload: Prisma.InputJsonValue) => Promise<{
        outcome: "confirmed" | "already_handled" | "not_found";
    }>;
    confirmPayment: (paymentRef: string, providerPayload: Prisma.InputJsonValue) => Promise<{
        outcome: "confirmed" | "already_handled" | "not_found";
    }>;
    failPaymentWithinTransaction: (tx: Prisma.TransactionClient, paymentRef: string, providerPayload: Prisma.InputJsonValue) => Promise<{
        outcome: "failed" | "already_handled" | "not_found";
    }>;
    failPayment: (paymentRef: string, providerPayload: Prisma.InputJsonValue) => Promise<{
        outcome: "failed" | "already_handled" | "not_found";
    }>;
};
//# sourceMappingURL=ticket-purchase.service.d.ts.map