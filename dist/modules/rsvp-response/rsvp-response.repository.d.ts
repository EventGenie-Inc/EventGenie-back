import prisma from '../../shared/prisma/prisma.client.js';
import { type Prisma } from '@prisma/client';
import { type CreateRsvpResponseDto } from './rsvp-response.types.js';
type Db = Prisma.TransactionClient | typeof prisma;
export declare const rsvpResponseRepository: {
    findAll: (inviteId: string) => Prisma.PrismaPromise<({
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
    findById: (id: string) => Prisma.Prisma__RsvpResponseClient<({
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
    }) | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    create: (inviteId: string, data: CreateRsvpResponseDto, db?: Db) => Prisma.Prisma__RsvpResponseClient<{
        id: string;
        createdAt: Date;
        inviteId: string;
        rsvpFieldId: string;
        value: string;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
export {};
//# sourceMappingURL=rsvp-response.repository.d.ts.map