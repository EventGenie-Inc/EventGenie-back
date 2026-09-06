import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import {} from './guest.types.js';
import {} from '@prisma/client';
// Guest has no tenantId column of its own — ownership is transitive
// through its direct eventId -> Event -> tenantId. Repository methods
// stay unscoped (or take an optional tenantId that filters through that
// one-hop relation); tenant ownership is enforced by the service layer,
// exactly like event-day.repository.ts / event.repository.ts.
const tenantOwnedGuestFilter = (tenantId) => tenantId ? { event: { tenantId, isArchived: false } } : {};
export const guestRepository = {
    findById: (id, includeArchived = false, tenantId) => prisma.guest.findFirst({
        where: {
            id,
            ...(includeArchived ? {} : { isArchived: false }),
            ...tenantOwnedGuestFilter(tenantId),
        },
    }),
    findAll: (tenantId, includeArchived = false) => prisma.guest.findMany({
        where: {
            ...(includeArchived ? {} : { isArchived: false }),
            ...tenantOwnedGuestFilter(tenantId),
        },
        orderBy: { createdAt: 'desc' },
    }),
    findAllForEvent: (eventId, includeArchived = false) => prisma.guest.findMany({
        where: {
            eventId,
            ...(includeArchived ? {} : { isArchived: false }),
        },
        orderBy: { createdAt: 'desc' },
    }),
    // Feeds both the dedup check (Task 4) and the tier-limit count — one
    // query, non-archived guests currently on this event, contacts only.
    findContactsForEvent: (eventId) => prisma.guest.findMany({
        where: { eventId, isArchived: false },
        select: { id: true, email: true, phoneNumber: true },
    }),
    countForEvent: (eventId) => prisma.guest.count({ where: { eventId, isArchived: false } }),
    // Manual single-guest create: Guest + Invite + InviteEventDay together,
    // in one transaction. Invite.deliveredAt stays null — nothing is sent
    // here, that's Part 2. deliveryMethod is inferred from which contact
    // field is present (product rule: exactly one is ever set at this
    // point). Invite creation stays paired with Guest creation even though
    // Guest now has its own eventId — InviteEventDay (the only place day
    // selections are recorded) requires a non-null inviteId, so day
    // selection still needs an Invite to attach to.
    createWithInvite: (eventId, userId, data) => prisma.$transaction(async (tx) => {
        const guest = await tx.guest.create({
            data: {
                eventId,
                firstName: data.firstName,
                surname: data.surname,
                email: data.email,
                phoneNumber: data.phoneNumber,
                isArchived: false,
            },
        });
        const invite = await tx.invite.create({
            data: {
                eventId,
                guestId: guest.id,
                token: crypto.randomBytes(32).toString('hex'),
                status: 'PENDING',
                used: false,
                deliveryMethod: (data.email ? 'EMAIL' : 'SMS'),
                expiresAt: null,
                isArchived: false,
                createdBy: userId,
                updatedBy: userId,
            },
        });
        await tx.inviteEventDay.createMany({
            data: data.eventDayIds.map((eventDayId) => ({ inviteId: invite.id, eventDayId })),
        });
        return guest;
    }),
    // Bulk import create — see guest-import.engine.ts for row validation.
    //
    // IDs are pre-generated client-side so Guest, Invite, and InviteEventDay
    // can each be written with one createMany call (4 queries total,
    // independent of row count) instead of 3 sequential round-trips per row.
    // An earlier per-row-loop version of this method was tested against the
    // real dev DB and blew Prisma's interactive-transaction timeout at just
    // 50 rows (150 sequential round-trips over the network to Neon); this
    // batched form is the actual fix, not just a bigger timeout number.
    bulkCreateWithInvites: (eventId, userId, rows) => prisma.$transaction(async (tx) => {
        const guestIds = rows.map(() => crypto.randomUUID());
        const inviteIds = rows.map(() => crypto.randomUUID());
        await tx.guest.createMany({
            data: rows.map((row, i) => ({
                id: guestIds[i],
                eventId,
                firstName: row.firstName,
                surname: row.surname,
                email: row.email,
                phoneNumber: row.phoneNumber,
                isArchived: false,
            })),
        });
        await tx.invite.createMany({
            data: rows.map((row, i) => ({
                id: inviteIds[i],
                eventId,
                guestId: guestIds[i],
                token: crypto.randomBytes(32).toString('hex'),
                status: 'PENDING',
                used: false,
                deliveryMethod: (row.email ? 'EMAIL' : 'SMS'),
                expiresAt: null,
                isArchived: false,
                createdBy: userId,
                updatedBy: userId,
            })),
        });
        await tx.inviteEventDay.createMany({
            data: rows.flatMap((row, i) => row.eventDayIds.map((eventDayId) => ({ inviteId: inviteIds[i], eventDayId }))),
        });
        return tx.guest.findMany({ where: { id: { in: guestIds } } });
    }),
    update: (id, data) => prisma.guest.update({
        where: { id },
        data: {
            ...(data.firstName !== undefined && { firstName: data.firstName }),
            ...(data.surname !== undefined && { surname: data.surname }),
            ...(data.email !== undefined && { email: data.email }),
            ...(data.phoneNumber !== undefined && { phoneNumber: data.phoneNumber }),
        },
    }),
    // archive/reactivate are NOT here — archiving/reactivating a guest must
    // cascade to its Invite(s) in one transaction (Part 1.5 Task 2), so that
    // logic lives inline in guest.service.ts, mirroring tenant.service.ts's
    // suspend/reactivate cascade rather than a single-row repository method.
};
//# sourceMappingURL=guest.repository.js.map