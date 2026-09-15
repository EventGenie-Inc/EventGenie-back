import { type Prisma } from '@prisma/client';
import { type UpsertEventDraftDto } from './event-draft.types.js';
export declare const eventDraftRepository: {
    findByTenantAndUser: (tenantId: string, userId: string) => Prisma.Prisma__EventDraftClient<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        currentStep: number;
        payload: Prisma.JsonValue;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    findById: (id: string) => Prisma.Prisma__EventDraftClient<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        currentStep: number;
        payload: Prisma.JsonValue;
    } | null, null, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    upsert: (tenantId: string, userId: string, data: UpsertEventDraftDto) => Prisma.Prisma__EventDraftClient<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        currentStep: number;
        payload: Prisma.JsonValue;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
    delete: (id: string) => Prisma.Prisma__EventDraftClient<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        createdByUserId: string;
        currentStep: number;
        payload: Prisma.JsonValue;
    }, never, import("@prisma/client/runtime/client").DefaultArgs, Prisma.PrismaClientOptions>;
};
//# sourceMappingURL=event-draft.repository.d.ts.map