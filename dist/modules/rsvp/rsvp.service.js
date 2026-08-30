import {} from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { attendanceRepository } from '../attendance/attendance.repository.js';
import { rsvpResponseRepository } from '../rsvp-response/rsvp-response.repository.js';
import { ticketRepository } from '../ticket/ticket.repository.js';
import { ticketPurchaseRepository } from '../ticket-purchase/ticket-purchase.repository.js';
import {} from './rsvp.types.js';
import { resolveEffectiveStatus, withEffectiveStatus } from '../event/event-status.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
// A guest has no account, no support channel, and no context beyond the
// one link they clicked — every message in this file is written for
// that reader specifically: what happened, and what they can do about
// it. Never leak tenant names, internal ids, guest counts, or anything
// about other guests; a guest's token only entitles them to know about
// their own invite.
// Same date format already used for guest-facing invite text
// (invite-dispatch.service.ts's earliestDayLabel) — kept identical so a
// guest sees one consistent date style across every message they get.
const formatGuestDate = (date) => date.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
// Guest-facing wording for the same three blocked statuses invites use
// (COMPLETED/CANCELLED read fine to a guest as-is); DRAFT gets its own
// text since "publish it before sending invitations" is organiser
// language a guest should never see. In practice a guest can only ever
// hold a token for an event that WAS published (invites can't be sent
// to a draft event — Task 3), so this branch is defensive, not reachable.
const RSVP_BLOCK_MESSAGES = {
    DRAFT: 'This event is not yet open for RSVPs.',
    COMPLETED: 'This event has already taken place.',
    CANCELLED: 'This event has been cancelled.',
};
// 403 — the guest is correctly identified (their token is valid), but
// the event's current state means RSVPs aren't accepted right now. Not
// a 409: nothing about THIS submission conflicts with anything; the
// door is simply closed regardless of what they submit.
const assertEventAcceptsRsvp = (effectiveStatus) => {
    if (effectiveStatus === 'PUBLISHED')
        return;
    throw new HttpError(403, RSVP_BLOCK_MESSAGES[effectiveStatus] ?? 'This event is not currently accepting RSVPs.');
};
// rsvpDeadline is independent of Event.status (Batch A Task 1) — an event
// can be perfectly PUBLISHED and still have RSVP submission closed. Only
// guest self-service is affected; organiser guest management in
// guest.service.ts never checks this.
const isRsvpDeadlinePassed = (rsvpDeadline) => !!rsvpDeadline && rsvpDeadline < new Date();
// 410 Gone, not 403 — the ability to RSVP genuinely existed and is now
// permanently gone as of a known point in time; that's precisely what
// Gone means, and it's a more specific signal to a frontend than the
// generic "not accepting RSVPs" 403 above. Same reasoning is applied
// below to an expired invite token.
const assertRsvpDeadlineNotPassed = (rsvpDeadline) => {
    if (isRsvpDeadlinePassed(rsvpDeadline)) {
        throw new HttpError(410, `Responses for this event closed on ${formatGuestDate(rsvpDeadline)}. Contact the organiser if you still need to RSVP.`);
    }
};
// Guest RSVP submissions are the first writes in this codebase performed by
// a non-platform actor. Invite.updatedBy is a plain String (not an FK to
// User), so this sentinel documents the convention for guest-originated writes.
const GUEST_ACTOR = 'guest-rsvp';
export const rsvpService = {
    // Public, unauthenticated read — returns flags rather than throwing on
    // invalid state, since the caller is a guest's browser rendering a form.
    validate: async (token) => {
        const invite = await inviteRepository.findByToken(token);
        // The one genuinely error-throwing case left in this method — with no
        // invite at all there's no record to hang isExpired/isUsed/etc. flags
        // off, so unlike those, this can't be turned into a flag.
        if (!invite) {
            throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
        }
        const isExpired = !!invite.expiresAt && invite.expiresAt < new Date();
        return {
            // event.status reported as the EFFECTIVE status, consistent with
            // every other read path — the guest's browser can check it to
            // decide whether to render the RSVP form at all.
            invite: { ...invite, event: withEffectiveStatus(invite.event) },
            isExpired,
            isUsed: invite.used,
            // Flag, not a throw — same "return flags, don't throw" design as
            // isExpired/isUsed above, so the frontend can render "Responses
            // closed" instead of the form.
            isRsvpDeadlinePassed: isRsvpDeadlinePassed(invite.event.rsvpDeadline),
        };
    },
    submit: (data) => prisma.$transaction(async (tx) => {
        const invite = await tx.invite.findUnique({
            where: { token: data.token },
            include: {
                inviteEventDay: true,
                event: { include: { tickets: true, eventDays: { where: { isArchived: false } } } },
            },
        });
        if (!invite) {
            throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
        }
        // 409 — a genuine state conflict: this exact invite was already
        // resolved (by this guest or whoever else holds the link), and
        // resubmitting would silently overwrite that response.
        if (invite.used) {
            throw new HttpError(409, 'This invitation has already been used to respond. Contact the organiser if you need to change your answer.');
        }
        // 410 — same reasoning as the RSVP-deadline case above: this
        // specific link had a lifespan and it has passed, distinct from
        // "not accepting RSVPs right now" (403) or "already answered" (409).
        if (invite.expiresAt && invite.expiresAt < new Date()) {
            throw new HttpError(410, `This invitation link expired on ${formatGuestDate(invite.expiresAt)}. Contact the organiser for a new one.`);
        }
        assertEventAcceptsRsvp(resolveEffectiveStatus(invite.event));
        assertRsvpDeadlineNotPassed(invite.event.rsvpDeadline);
        const attendances = [];
        if (data.attending) {
            const invitedDayIds = new Set(invite.inviteEventDay.map((d) => d.eventDayId));
            const attendingDayIds = data.attendingDayIds ?? [];
            for (const eventDayId of attendingDayIds) {
                if (!invitedDayIds.has(eventDayId)) {
                    // 400 — malformed submission: the day ids in `invitedDayIds`
                    // are never guest-visible, so this can't name the offending
                    // day without leaking an internal id; the guidance to
                    // refresh covers the only two ways this happens (a stale
                    // page, or a tampered request).
                    throw new HttpError(400, "One of the days you selected isn't part of this invitation. Please refresh the page and try again.");
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
            // 409 — a genuine state conflict: the ticket exists, but its
            // current state (archived / marked unavailable) conflicts with
            // trying to purchase it right now.
            if (!ticket || ticket.isArchived || !ticket.isAvailable) {
                throw new HttpError(409, 'This ticket type is no longer available. Please choose a different option or contact the organiser.');
            }
            const quantity = data.ticketQuantity ?? 1;
            // 409 — same bucket: sold-out is a conflict with current stock,
            // not a malformed request. soldCount/totalQuantity are internal
            // counters and stay out of the message.
            if (ticket.totalQuantity !== null && ticket.soldCount + quantity > ticket.totalQuantity) {
                throw new HttpError(409, "There aren't enough tickets left for the quantity you selected. Try a smaller quantity or contact the organiser.");
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