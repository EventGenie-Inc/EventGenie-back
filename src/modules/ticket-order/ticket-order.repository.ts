import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';

type Db = Prisma.TransactionClient | typeof prisma;

// Everything an order's views and rules read: items, every payment attempt,
// its tickets with their check-ins.
export const orderInclude = {
  items: { orderBy: { createdAt: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' } },
  tickets: { orderBy: { indexInOrder: 'asc' }, include: { checkIns: true } },
} satisfies Prisma.TicketOrderInclude;

export type OrderRow = Prisma.TicketOrderGetPayload<{ include: typeof orderInclude }>;

export const ticketOrderRepository = {
  findById: (id: string, db: Db = prisma) => db.ticketOrder.findUnique({ where: { id }, include: orderInclude }),

  // Locks the order's row for the rest of the transaction: every write to an
  // order's state (confirm, fail, expire, retry, take back) takes it first.
  lock: async (tx: Prisma.TransactionClient, orderId: string): Promise<void> => {
    await tx.$queryRaw`SELECT id FROM "TicketOrder" WHERE id = ${orderId} FOR UPDATE`;
  },

  findByIdempotencyKey: (eventId: string, idempotencyKey: string, db: Db = prisma) =>
    db.ticketOrder.findUnique({ where: { eventId_idempotencyKey: { eventId, idempotencyKey } }, include: orderInclude }),

  // The same buyer, event and items, still pending and held.
  findPendingByFingerprint: (fingerprint: string, now: Date, db: Db = prisma) =>
    db.ticketOrder.findFirst({
      where: { requestFingerprint: fingerprint, status: 'PENDING', holdExpiresAt: { gt: now }, holdReleasedAt: null },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
    }),

  findPaymentByReference: (reference: string, db: Db = prisma) =>
    db.ticketOrderPayment.findUnique({ where: { reference } }),

  // A payment by Paystack's keys (a refund or dispute names the original).
  findOrderByPaymentKeys: async (keys: { reference: string | null; transactionId: string | null }, db: Db = prisma) => {
    if (keys.reference) {
      const payment = await db.ticketOrderPayment.findUnique({ where: { reference: keys.reference } });
      if (payment) return db.ticketOrder.findUnique({ where: { id: payment.orderId }, include: orderInclude });
    }
    if (keys.transactionId) {
      return db.ticketOrder.findFirst({ where: { paystackTransactionId: keys.transactionId }, include: orderInclude });
    }
    return null;
  },

  // ── Stock ──
  //
  // One conditional UPDATE per type, never read-then-write: two checkouts for
  // the last ticket serialise on the row, and the second re-checks its WHERE
  // against the first's hold. Legacy types with no quantity are unlimited.
  hold: async (tx: Prisma.TransactionClient, ticketTypeId: string, quantity: number): Promise<boolean> =>
    (await tx.$executeRaw`
      UPDATE "Ticket" SET "heldCount" = "heldCount" + ${quantity}
      WHERE "id" = ${ticketTypeId}
        AND "isArchived" = false AND "status" = 'ACTIVE'
        AND ("totalQuantity" IS NULL OR "soldCount" + "heldCount" + ${quantity} <= "totalQuantity")
    `) === 1,

  releaseHold: (tx: Prisma.TransactionClient, ticketTypeId: string, quantity: number) =>
    tx.$executeRaw`UPDATE "Ticket" SET "heldCount" = GREATEST("heldCount" - ${quantity}, 0) WHERE "id" = ${ticketTypeId}`,

  // Sold: the hold (if it still stands) becomes sales. A sale after the hold
  // lapsed is recorded anyway: the guest has paid.
  sell: (tx: Prisma.TransactionClient, ticketTypeId: string, quantity: number, fromHold: boolean) =>
    fromHold
      ? tx.$executeRaw`UPDATE "Ticket" SET "soldCount" = "soldCount" + ${quantity}, "heldCount" = GREATEST("heldCount" - ${quantity}, 0) WHERE "id" = ${ticketTypeId}`
      : tx.$executeRaw`UPDATE "Ticket" SET "soldCount" = "soldCount" + ${quantity} WHERE "id" = ${ticketTypeId}`,

  // A voided ticket frees its place.
  unsell: (tx: Prisma.TransactionClient, ticketTypeId: string, quantity: number) =>
    tx.$executeRaw`UPDATE "Ticket" SET "soldCount" = GREATEST("soldCount" - ${quantity}, 0) WHERE "id" = ${ticketTypeId}`,

  // Over its quantity (sold past it after a late payment)?
  isOversold: async (tx: Prisma.TransactionClient, ticketTypeId: string): Promise<boolean> => {
    const row = await tx.ticket.findUnique({ where: { id: ticketTypeId }, select: { soldCount: true, totalQuantity: true } });
    return !!row && row.totalQuantity !== null && row.soldCount > row.totalQuantity;
  },

  // Orders whose hold has run out, still unpaid.
  findExpired: (now: Date, eventIds?: string[]) =>
    prisma.ticketOrder.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] }, holdReleasedAt: null, holdExpiresAt: { lte: now }, ...(eventIds && { eventId: { in: eventIds } }) },
      select: { id: true },
      take: 200,
    }),

  // Paid orders whose confirmation email hasn't gone (a failed send, or a
  // crash between claim and send), claimed more than 10 minutes ago or never.
  findUnsentConfirmations: (now: Date, eventIds?: string[]) =>
    prisma.ticketOrder.findMany({
      where: {
        status: { in: ['PAID', 'UNDER_REVIEW'] },
        paidAt: { not: null },
        confirmationEmailSentAt: null,
        OR: [{ confirmationEmailClaimedAt: null }, { confirmationEmailClaimedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }],
        ...(eventIds && { eventId: { in: eventIds } }),
      },
      select: { id: true },
      take: 50,
    }),

  // Claims the confirmation email once (a conditional update), before it is
  // sent, so two paths never both send it.
  claimConfirmationEmail: async (orderId: string, now: Date): Promise<boolean> =>
    (
      await prisma.ticketOrder.updateMany({
        where: {
          id: orderId,
          confirmationEmailSentAt: null,
          OR: [{ confirmationEmailClaimedAt: null }, { confirmationEmailClaimedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }],
        },
        data: { confirmationEmailClaimedAt: now },
      })
    ).count === 1,

  markConfirmationEmail: (orderId: string, sent: boolean) =>
    prisma.ticketOrder.update({
      where: { id: orderId },
      data: sent ? { confirmationEmailSentAt: new Date() } : { confirmationEmailClaimedAt: null },
    }),
};
