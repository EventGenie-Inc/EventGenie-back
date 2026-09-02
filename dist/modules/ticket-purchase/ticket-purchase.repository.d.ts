import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type CreateTicketPurchaseDto } from './ticket-purchase.types.js';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const ticketPurchaseRepository: {
    findAll: (inviteId: string) => Prisma.PrismaPromise<({
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
            price: Prisma.Decimal;
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
        totalPaid: Prisma.Decimal;
        paymentRef: string | null;
        purchasedAt: Date;
    })[]>;
    findById: (id: string) => Prisma.Prisma__TicketPurchaseClient<({
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
            price: Prisma.Decimal;
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
        totalPaid: Prisma.Decimal;
        paymentRef: string | null;
        purchasedAt: Date;
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    create: (data: CreateTicketPurchaseDto, db?: Db) => Prisma.Prisma__TicketPurchaseClient<{
        id: string;
        inviteId: string;
        currency: string;
        ticketId: string;
        quantity: number;
        totalPaid: Prisma.Decimal;
        paymentRef: string | null;
        purchasedAt: Date;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
export {};
//# sourceMappingURL=ticket-purchase.repository.d.ts.map