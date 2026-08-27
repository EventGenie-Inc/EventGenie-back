export declare const ticketPurchaseService: {
    getAll: (inviteId: string) => import("@prisma/client").Prisma.PrismaPromise<({
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
            price: import("@prisma/client-runtime-utils").Decimal;
            currency: string;
            totalQuantity: number | null;
            soldCount: number;
            isAvailable: boolean;
        };
    } & {
        id: string;
        inviteId: string;
        currency: string;
        ticketId: string;
        quantity: number;
        totalPaid: import("@prisma/client-runtime-utils").Decimal;
        paymentRef: string | null;
        purchasedAt: Date;
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
            price: import("@prisma/client-runtime-utils").Decimal;
            currency: string;
            totalQuantity: number | null;
            soldCount: number;
            isAvailable: boolean;
        };
    } & {
        id: string;
        inviteId: string;
        currency: string;
        ticketId: string;
        quantity: number;
        totalPaid: import("@prisma/client-runtime-utils").Decimal;
        paymentRef: string | null;
        purchasedAt: Date;
    }>;
};
//# sourceMappingURL=ticket-purchase.service.d.ts.map