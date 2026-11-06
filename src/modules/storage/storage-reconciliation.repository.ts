import { Prisma, type StorageReconciliation } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

export interface ReconciliationTotals {
  listedCount: number;
  listedBytes: number;
  orphanCount: number;
  orphanBytes: number;
  missingCount: number;
  sizeMismatchCount: number;
}

// BigInt columns handed on as plain numbers (a bigint can't be written to JSON).
export const toReconciliationView = (r: StorageReconciliation, withDetails: boolean) => ({
  id: r.id,
  periodKey: r.periodKey,
  requestedBy: r.requestedBy,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
  error: r.error,
  listedCount: r.listedCount,
  listedBytes: Number(r.listedBytes),
  orphanCount: r.orphanCount,
  orphanBytes: Number(r.orphanBytes),
  missingCount: r.missingCount,
  sizeMismatchCount: r.sizeMismatchCount,
  ...(withDetails ? { details: r.details } : {}),
});

export const storageReconciliationRepository = {
  // The claim: null when this period already has a run (unique periodKey).
  claim: async (periodKey: string, requestedBy: string | null, now: Date): Promise<StorageReconciliation | null> => {
    try {
      return await prisma.storageReconciliation.create({ data: { periodKey, requestedBy, startedAt: now } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  },

  findByPeriodKey: (periodKey: string) => prisma.storageReconciliation.findUnique({ where: { periodKey } }),

  finish: (id: string, totals: ReconciliationTotals, details: Prisma.InputJsonValue, completedAt: Date) =>
    prisma.storageReconciliation.update({
      where: { id },
      data: {
        ...totals,
        listedBytes: BigInt(totals.listedBytes),
        orphanBytes: BigInt(totals.orphanBytes),
        details,
        completedAt,
        error: null,
      },
    }),

  fail: (id: string, error: string, completedAt: Date) =>
    prisma.storageReconciliation.update({ where: { id }, data: { error: error.slice(0, 1000), completedAt } }),

  findRecent: (take: number) => prisma.storageReconciliation.findMany({ orderBy: { startedAt: 'desc' }, take }),

  findById: (id: string) => prisma.storageReconciliation.findUnique({ where: { id } }),
};
