import prisma from '../../shared/prisma/prisma.client.js';
import { Prisma } from '@prisma/client';
import { type CreateMismatchInput } from './payment-reconciliation.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

export const paymentReconciliationRepository = {
  createMismatch: (data: CreateMismatchInput, db: Db = prisma) =>
    db.paymentMismatch.create({
      data: {
        runId: data.runId ?? null,
        source: data.source,
        kind: data.kind,
        paystackReference: data.paystackReference ?? null,
        paystackTransactionId: data.paystackTransactionId ?? null,
        tenantId: data.tenantId ?? null,
        eventId: data.eventId ?? null,
        expectedAmountCents: data.expectedAmountCents ?? null,
        actualAmountCents: data.actualAmountCents ?? null,
        currency: data.currency ?? null,
        ...(data.details !== undefined && { details: data.details as Prisma.InputJsonValue }),
      },
    }),

  // The claim: one run per UTC day across every server instance. null when
  // another instance (or an earlier hour) already has it.
  claimRun: async (runDate: string) => {
    try {
      return await prisma.paymentReconciliationRun.create({ data: { runDate } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  },

  finishRun: (id: string, data: { status: 'DONE' | 'FAILED'; mismatchCount: number; summary: Record<string, unknown> }) =>
    prisma.paymentReconciliationRun.update({
      where: { id },
      data: { status: data.status, mismatchCount: data.mismatchCount, summary: data.summary as Prisma.InputJsonValue, finishedAt: new Date() },
    }),

  listRuns: (limit: number) =>
    prisma.paymentReconciliationRun.findMany({ orderBy: { runDate: 'desc' }, take: limit }),

  listMismatches: (filter: { status: 'open' | 'resolved' | 'all'; cursor?: string; limit: number }) =>
    prisma.paymentMismatch.findMany({
      where: filter.status === 'all' ? {} : { resolvedAt: filter.status === 'open' ? null : { not: null } },
      include: { run: { select: { runDate: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit + 1,
      ...(filter.cursor && { cursor: { id: filter.cursor }, skip: 1 }),
    }),
};
