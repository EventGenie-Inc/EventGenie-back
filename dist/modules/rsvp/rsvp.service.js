import prisma from '../../shared/prisma/prisma.client.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { attendanceRepository } from '../attendance/attendance.repository.js';
import { rsvpResponseRepository } from '../rsvp-response/rsvp-response.repository.js';
import { ticketRepository } from '../ticket/ticket.repository.js';
import { ticketPurchaseRepository } from '../ticket-purchase/ticket-purchase.repository.js';
import {} from './rsvp.types.js';
// Guest RSVP submissions are the first writes in this codebase performed by
// a non-platform actor. Invite.updatedBy is a plain String (not an FK to
// User), so this sentinel documents the convention for guest-originated writes.
const GUEST_ACTOR = 'guest-rsvp';
export const rsvpService = {
    // Public, unauthenticated read — returns flags rather than throwing on
    // invalid state, since the caller is a guest's browser rendering a form.
    validate: async (token) => {
        const invite = await inviteRepository.findByToken(token);
        if (!invite)
            throw new Error('Invalid RSVP token');
        const isExpired = !!invite.expiresAt && invite.expiresAt < new Date();
        return {
            invite,
            isExpired,
            isUsed: invite.used,
        };
    },
    submit: (data) => prisma.$transaction(async (tx) => {
        const invite = await tx.invite.findUnique({
            where: { token: data.token },
            include: {
                inviteEventDay: true,
                event: { include: { tickets: true } },
            },
        });
        if (!invite)
            throw new Error('Invalid RSVP token');
        if (invite.used)
            throw new Error('This invite has already been used');
        if (invite.expiresAt && invite.expiresAt < new Date()) {
            throw new Error('This invite has expired');
        }
        const attendances = [];
        if (data.attending) {
            const invitedDayIds = new Set(invite.inviteEventDay.map((d) => d.eventDayId));
            const attendingDayIds = data.attendingDayIds ?? [];
            for (const eventDayId of attendingDayIds) {
                if (!invitedDayIds.has(eventDayId)) {
                    throw new Error('Invalid event day selection');
                }
            }
            for (const eventDayId of attendingDayIds) {
                attendances.push(await attendanceRepository.create(invite.id, eventDayId, tx));
            }
        }
        const rsvpResponses = [];
        for (const response of data.rsvpResponses ?? []) {
            rsvpResponses.push(await rsvpResponseRepository.create(invite.id, response, tx));
        }
        let ticketPurchase = null;
        if (data.ticketId && data.attending) {
            const ticket = invite.event.tickets.find((t) => t.id === data.ticketId);
            if (!ticket || ticket.isArchived || !ticket.isAvailable) {
                throw new Error('Ticket is not available');
            }
            const quantity = data.ticketQuantity ?? 1;
            if (ticket.totalQuantity !== null && ticket.soldCount + quantity > ticket.totalQuantity) {
                throw new Error('Not enough tickets remaining');
            }
            // totalPaid is always computed server-side — never trust a client-supplied amount.
            const totalPaid = Number(ticket.price) * quantity;
            ticketPurchase = await ticketPurchaseRepository.create({
                ticketId: ticket.id,
                inviteId: invite.id,
                quantity,
                totalPaid,
                currency: ticket.currency,
                ...(data.paymentRef !== undefined && { paymentRef: data.paymentRef }),
            }, tx);
            await ticketRepository.incrementSoldCount(ticket.id, quantity, tx);
        }
        const updatedInvite = await tx.invite.update({
            where: { id: invite.id },
            data: {
                used: true,
                usedAt: new Date(),
                status: data.attending ? 'ACCEPTED' : 'DECLINED',
                updatedBy: GUEST_ACTOR,
            },
        });
        return { invite: updatedInvite, attendances, rsvpResponses, ticketPurchase };
    }),
};
//# sourceMappingURL=rsvp.service.js.map