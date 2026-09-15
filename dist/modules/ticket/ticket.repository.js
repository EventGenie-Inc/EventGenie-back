import prisma from '../../shared/prisma/prisma.client.js';
import {} from '@prisma/client';
import {} from './ticket.types.js';
export const ticketRepository = {
    findAll: (eventId, opts) => prisma.ticket.findMany({
        where: {
            eventId,
            isArchived: false,
            ...(opts?.availableOnly ? { isAvailable: true } : {}),
        },
        orderBy: { createdAt: 'desc' },
    }),
    findById: (id, db = prisma) => db.ticket.findFirst({
        where: { id, isArchived: false },
    }),
    create: (eventId, userId, data) => prisma.ticket.create({
        data: {
            eventId,
            name: data.name,
            description: data.description ?? null,
            price: data.price,
            currency: data.currency ?? 'ZAR',
            totalQuantity: data.totalQuantity ?? null,
            soldCount: 0,
            isAvailable: true,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
        },
    }),
    update: (id, userId, data) => prisma.ticket.update({
        where: { id },
        data: {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.description !== undefined && { description: data.description ?? null }),
            ...(data.price !== undefined && { price: data.price }),
            ...(data.currency !== undefined && { currency: data.currency }),
            ...(data.totalQuantity !== undefined && { totalQuantity: data.totalQuantity ?? null }),
            ...(data.isAvailable !== undefined && { isAvailable: data.isAvailable }),
            updatedBy: userId,
        },
    }),
    archive: (id, userId) => prisma.ticket.update({
        where: { id },
        data: { isArchived: true, updatedBy: userId },
    }),
    // ─────────────────────────────────────────
    //  STOCK — Ticketing & Payments batch
    //
    //  Overselling is prevented HERE, at reserveHold, not at confirmSale.
    //  reserveHold is the only place that ever refuses a request for lack
    //  of stock; incrementSoldCount/releaseHold below are only ever called
    //  for a quantity a prior reserveHold already, verifiably, secured —
    //  they have nothing left to guard and are plain unconditional
    //  updates. See ticket-purchase.service.ts's report comment for the
    //  full hold-with-expiry design and why.
    // ─────────────────────────────────────────
    // Single-statement, conditional UPDATE — not a read-then-check-then-
    // write. Two concurrent calls for the same ticket's last unit
    // serialize on Postgres's row lock for that UPDATE; whichever runs
    // second re-evaluates its WHERE clause against the FIRST call's
    // already-applied heldCount increment, so at most one of them can
    // ever see enough room. Returns whether THIS call secured the hold —
    // false means either the ticket doesn't exist / is
    // archived/unavailable, or there wasn't enough stock
    // (totalQuantity - soldCount - heldCount < quantity) at that instant.
    reserveHold: async (ticketId, quantity, db = prisma) => {
        const affected = await db.$executeRaw `
      UPDATE "Ticket"
      SET "heldCount" = "heldCount" + ${quantity}
      WHERE "id" = ${ticketId}
        AND "isArchived" = false
        AND "isAvailable" = true
        AND ("totalQuantity" IS NULL OR "soldCount" + "heldCount" + ${quantity} <= "totalQuantity")
    `;
        return affected === 1;
    },
    // Releases a hold that failed or expired without paying — unconditional,
    // since the caller only ever passes a quantity a matching reserveHold
    // already secured for this exact purchase, exactly once.
    releaseHold: (ticketId, quantity, db = prisma) => db.ticket.update({
        where: { id: ticketId },
        data: { heldCount: { decrement: quantity } },
    }),
    // Converts a hold into a real sale (or, for a late confirmation whose
    // hold already lapsed, just records the sale outright) — the caller
    // decides separately whether releaseHold also needs to run alongside
    // this, based on the purchase's pre-transition status. Accepts an
    // optional transaction client so it can run standalone (rare) or
    // inside the confirm-purchase transaction (the normal case).
    incrementSoldCount: (id, quantity, db = prisma) => db.ticket.update({
        where: { id },
        data: { soldCount: { increment: quantity } },
    }),
};
//# sourceMappingURL=ticket.repository.js.map