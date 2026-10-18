import { type ConsentKind, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { type ConsentRecordRow } from './consent.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

const ROW_SELECT = {
  seq: true,
  kind: true,
  memoryItemId: true,
  action: true,
  wordingVersion: true,
  recordedAt: true,
} as const;

// ─────────────────────────────────────────
//  CONSENT RECORDS — APPEND-ONLY
//
//  Inserts and reads, nothing else: there is deliberately no update or
//  delete method here, and the database refuses an UPDATE of a record
//  anyway (the ConsentRecord_no_update trigger). A permission withdrawn is
//  a NEW record; the current state of a subject is its latest record by
//  `seq` (consent-state.util.ts). Same rule as payment-ledger.repository.ts.
//
//  No tenant filter: ConsentRecord has no tenantId of its own, and every
//  caller has already gated on the event (eventService.getScoped) or on the
//  guest's invite token before reaching here.
// ─────────────────────────────────────────
export const consentRepository = {
  appendMany: (
    rows: {
      eventId: string;
      kind: ConsentKind;
      memoryItemId: string | null;
      userId: string | null;
      guestId: string | null;
      action: 'GRANTED' | 'WITHDRAWN';
      wording: string;
      wordingVersion: number;
    }[],
    db: Db = prisma
  ) => (rows.length === 0 ? Promise.resolve({ count: 0 }) : db.consentRecord.createMany({ data: rows })),

  // Every record of one event, oldest first: enough to fold every
  // subject's current state in one query.
  findForEvent: (eventId: string, db: Db = prisma): Promise<ConsentRecordRow[]> =>
    db.consentRecord.findMany({ where: { eventId }, select: ROW_SELECT, orderBy: { seq: 'asc' } }),

  findForEvents: (eventIds: string[]): Promise<(ConsentRecordRow & { eventId: string })[]> =>
    eventIds.length === 0
      ? Promise.resolve([])
      : prisma.consentRecord.findMany({
          where: { eventId: { in: eventIds } },
          select: { ...ROW_SELECT, eventId: true },
          orderBy: { seq: 'asc' },
        }),

  // One kind's records for the given photos, oldest first.
  findForItems: (memoryItemIds: string[], kind: ConsentKind, db: Db = prisma): Promise<ConsentRecordRow[]> =>
    memoryItemIds.length === 0
      ? Promise.resolve([])
      : db.consentRecord.findMany({
          where: { memoryItemId: { in: memoryItemIds }, kind },
          select: ROW_SELECT,
          orderBy: { seq: 'asc' },
        }),
};
