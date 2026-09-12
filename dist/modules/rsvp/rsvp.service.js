import {} from '@prisma/client';
import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { ticketPurchaseService } from '../ticket-purchase/ticket-purchase.service.js';
import {} from './rsvp.types.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { normalizeEmail, assertValidEmail, normalizePhoneToE164 } from '../guest/guest-validation.util.js';
// A guest has no account, no support channel, and no context beyond the
// one link they clicked — every message in this file is written for
// that reader specifically: what happened, and what they can do about
// it. Never leak tenant names, internal ids, guest counts, or anything
// about other guests; a guest's token only entitles them to know about
// their own invite.
// Guest-facing wording for the same three blocked statuses invites use
// (COMPLETED/CANCELLED read fine to a guest as-is); DRAFT gets its own
// text since "publish it before sending invitations" is organiser
// language a guest should never see. In practice a guest can only ever
// hold a token for an event that WAS published (invites can't be sent
// to a draft event — Task 3), so this branch is defensive, not reachable.
// Exported — event-public.service.ts's registration flow (G2) reuses
// the COMPLETED/CANCELLED wording verbatim (they read fine for either
// context, same reasoning as this comment already gave) and overrides
// DRAFT with its own text, rather than duplicating the two shared strings.
export const RSVP_BLOCK_MESSAGES = {
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
//
// This is now the ONLY gate distinguishing "still open" from "closed" —
// a guest may resubmit (edit) their response as many times as they like
// up to this point, and an event with no deadline stays editable until
// assertEventAcceptsRsvp's own status check closes it at COMPLETED.
// `isEdit` only changes the wording: a guest editing an existing answer
// is told their existing response stands, not urged to "still RSVP".
const assertRsvpDeadlineNotPassed = (rsvpDeadline, isEdit) => {
    if (isRsvpDeadlinePassed(rsvpDeadline)) {
        const deadlineText = formatGuestDate(rsvpDeadline);
        throw new HttpError(410, isEdit
            ? `Responses for this event closed on ${deadlineText}. Your existing response stands — contact the organiser if you need to change it.`
            : `Responses for this event closed on ${deadlineText}. Contact the organiser if you still need to RSVP.`);
    }
};
// Guest RSVP submissions are the first writes in this codebase performed by
// a non-platform actor. Invite.updatedBy is a plain String (not an FK to
// User), so this sentinel documents the convention for guest-originated writes.
const GUEST_ACTOR = 'guest-rsvp';
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isPositiveInteger = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0;
const isValidRsvpResponseShape = (value) => typeof value === 'object' &&
    value !== null &&
    isNonEmptyString(value['rsvpFieldId']) &&
    typeof value['value'] === 'string';
// No domain concept of "party size" exists yet — an Invite is 1:1 with a
// guest, and ticketing has no payment integration to derive a real limit
// from. 10 is a generous cap for one guest buying on behalf of their
// household while still bounding how much of a small venue's stock a
// single submission can claim; it's a sanity ceiling independent of (and
// in addition to) the per-ticket totalQuantity check further down.
const MAX_TICKET_QUANTITY = 10;
// A single guard for the whole payload, run once before the transaction
// opens — every field below arrives straight from an unauthenticated
// POST body, so a malformed shape anywhere must be rejected before any
// database work begins, not discovered piecemeal at each field's point
// of use (which is how `token` alone reaching tx.invite.findUnique as
// `undefined` used to raise a raw Prisma validation error — a 500 that,
// in development, dumps the Invite model schema to an anonymous caller;
// same fix as memory-hub.service.ts's guest upload path). This checks
// SHAPE only — whether an id actually belongs to THIS invite's event
// (rsvpFieldId, ticketId, day ids) can only be checked once the invite
// is loaded, same as the existing ticket/day-id re-validation below.
const assertValidSubmission = (data) => {
    if (!isNonEmptyString(data.token)) {
        throw new HttpError(400, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }
    if (data.attendingDayIds !== undefined && (!Array.isArray(data.attendingDayIds) || !data.attendingDayIds.every(isNonEmptyString))) {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
    if (data.rsvpResponses !== undefined && (!Array.isArray(data.rsvpResponses) || !data.rsvpResponses.every(isValidRsvpResponseShape))) {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
    if (data.plusOneNames !== undefined && (!Array.isArray(data.plusOneNames) || !data.plusOneNames.every(isNonEmptyString))) {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
    if (data.ticketId !== undefined && !isNonEmptyString(data.ticketId)) {
        throw new HttpError(400, "The selected ticket isn't valid. Please refresh the page and try again.");
    }
    // Bounded before any arithmetic touches it — an unvalidated ticketQuantity
    // used to coerce in `soldCount + quantity`, silently defeating the
    // totalQuantity check below (a stock-limit bypass), then reach Prisma as
    // NaN/a string and raise the same class of schema-leaking error as token.
    if (data.ticketQuantity !== undefined && (!isPositiveInteger(data.ticketQuantity) || data.ticketQuantity > MAX_TICKET_QUANTITY)) {
        throw new HttpError(400, `Ticket quantity must be a whole number between 1 and ${MAX_TICKET_QUANTITY}.`);
    }
    if (data.paymentRef !== undefined && typeof data.paymentRef !== 'string') {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
    if (data.firstName !== undefined && typeof data.firstName !== 'string') {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
    if (data.surname !== undefined && typeof data.surname !== 'string') {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
    if (data.email !== undefined && typeof data.email !== 'string') {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
    if (data.phoneNumber !== undefined && typeof data.phoneNumber !== 'string') {
        throw new HttpError(400, 'Something went wrong with your response. Please refresh the page and try again.');
    }
};
// undefined (field omitted) and '' (submitted blank) both mean "leave
// existing data alone" — a guest resubmitting a form that only shows
// SOME fields (e.g. a plain "attending?" toggle with no name field at
// all) must never be treated as clearing what an earlier submission, or
// the organiser, already set. Only a genuinely non-empty value is ever
// written.
const trimToUndefined = (value) => {
    if (value === undefined)
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};
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
        const ticketPurchase = invite.ticketPurchases[0] ?? null;
        return {
            // Deliberate, hand-picked projection — a guest sees an invitation,
            // not a database row. Mirrors event-public.service.ts's
            // toPublicView: no tenantId, no createdByUserId/createdBy/updatedBy,
            // no coverImagePublicId, no shareToken, no internal counters
            // (Ticket.soldCount). Built as an explicit allowlist (not a spread
            // of the Prisma row) so this can never silently start leaking a
            // field added to Invite/Event/Guest/Ticket later.
            invite: {
                // The invite's own credential — already known to this caller (it's
                // how they reached this response), and submit()/reloadAfterDeadline
                // on the frontend resend it, so it stays in the payload.
                token: invite.token,
                status: invite.status,
                expiresAt: invite.expiresAt,
                guest: {
                    firstName: invite.guest.firstName,
                    surname: invite.guest.surname,
                    email: invite.guest.email,
                    phoneNumber: invite.guest.phoneNumber,
                    plusOnesAllowed: invite.guest.plusOnesAllowed,
                },
                // The days THIS invite offers — never every EventDay on the
                // event (a guest may be invited to a subset).
                inviteEventDay: invite.inviteEventDay.map((d) => ({
                    eventDay: {
                        id: d.eventDay.id,
                        label: d.eventDay.label,
                        date: d.eventDay.date,
                        startTime: d.eventDay.startTime,
                        endTime: d.eventDay.endTime,
                    },
                })),
                event: {
                    name: invite.event.name,
                    description: invite.event.description,
                    hostName: invite.event.hostName,
                    location: invite.event.location,
                    address: invite.event.address,
                    coverImageUrl: invite.event.coverImageUrl,
                    rsvpDeadline: invite.event.rsvpDeadline,
                    // Reported as the EFFECTIVE status, consistent with every other
                    // read path — the guest's browser branches on this to decide
                    // whether to render the RSVP form at all.
                    status: resolveEffectiveStatus(invite.event),
                    ticketing: invite.event.ticketing,
                    // Deliberately added to this explicit allowlist, not a spread —
                    // see this projection's own header comment. Informational only
                    // (schema.prisma's comment on Event.ticketsRefundable), but
                    // must reach the guest BEFORE they pay: someone should know
                    // what they're agreeing to at the point of purchase, not
                    // discover it afterwards. Meaningless while ticketing is FREE;
                    // sent regardless since it costs nothing and keeps this
                    // projection simple.
                    ticketsRefundable: invite.event.ticketsRefundable,
                    rsvpFields: invite.event.rsvpFields.map((f) => ({
                        id: f.id,
                        label: f.label,
                        fieldType: f.fieldType,
                        isRequired: f.isRequired,
                        options: f.options,
                    })),
                    // Only non-archived, isAvailable tickets — see
                    // invite.repository.ts's findByToken.
                    tickets: invite.event.tickets.map((t) => ({
                        id: t.id,
                        name: t.name,
                        price: t.price,
                        currency: t.currency,
                    })),
                },
            },
            isExpired,
            isUsed: invite.used,
            // Flag, not a throw — same "return flags, don't throw" design as
            // isExpired/isUsed above, so the frontend can render "Responses
            // closed" instead of the form.
            isRsvpDeadlinePassed: isRsvpDeadlinePassed(invite.event.rsvpDeadline),
            // Added for the edit form to prefill from — a guest revisiting
            // their link (isUsed: true, deadline not passed) needs to see what
            // they said last time, not a blank form. Additive only; nothing
            // above this line changed shape.
            attendingDayIds: invite.attendances.map((a) => a.eventDayId),
            rsvpResponses: invite.rsvpResponses.map((r) => ({ rsvpFieldId: r.rsvpFieldId, value: r.value })),
            plusOneNames: invite.guest.plusOnes.map((p) => p.firstName),
            ticketPurchase: ticketPurchase
                ? {
                    ticketId: ticketPurchase.ticketId,
                    quantity: ticketPurchase.quantity,
                    totalPaid: ticketPurchase.totalPaid,
                    currency: ticketPurchase.currency,
                    // PENDING/PAID/FAILED/EXPIRED — lets the guest's browser
                    // show "confirming your payment" / "paid" / "try again"
                    // instead of assuming existence-of-a-row means paid, which
                    // was true before Ticketing & Payments and no longer is.
                    status: ticketPurchase.status,
                }
                : null,
        };
    },
    submit: async (data) => {
        assertValidSubmission(data);
        const result = await prisma.$transaction(async (tx) => {
            // Every lookup a later step could need is folded into this ONE
            // query — existing plus-ones (with their invite ids, for archiving)
            // and any existing ticket purchase included right here — rather
            // than a separate round trip per lookup. Each `await` inside an
            // interactive transaction is a full network round trip to Neon,
            // measured in testing at ~300-500ms; a handful of "just one more
            // lookup" calls is exactly what re-introduces the timeout this
            // whole file exists to avoid, even after every WRITE is batched.
            const invite = await tx.invite.findUnique({
                where: { token: data.token },
                include: {
                    guest: {
                        include: {
                            plusOnes: {
                                where: { isArchived: false },
                                include: { invites: { where: { isArchived: false }, select: { id: true } } },
                            },
                        },
                    },
                    inviteEventDay: true,
                    ticketPurchases: true,
                    event: {
                        include: {
                            tickets: true,
                            eventDays: { where: { isArchived: false } },
                            rsvpFields: { where: { isArchived: false } },
                        },
                    },
                },
            });
            if (!invite) {
                throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
            }
            // 410 — same reasoning as the RSVP-deadline case below: this
            // specific link had a lifespan and it has passed, distinct from
            // "not accepting RSVPs right now" (403) or "closed" (410, deadline).
            // Applies uniformly to a first submission and an edit — an
            // organiser-set expiry on the invite itself is a harder outer bound
            // than the event-wide RSVP deadline, and nothing below relaxes it.
            if (invite.expiresAt && invite.expiresAt < new Date()) {
                throw new HttpError(410, `This invitation link expired on ${formatGuestDate(invite.expiresAt)}. Contact the organiser for a new one.`);
            }
            assertEventAcceptsRsvp(resolveEffectiveStatus(invite.event));
            // A guest may resubmit (edit) their response as many times as they
            // like up to the RSVP deadline — invite.used no longer blocks a
            // second submission by itself. `invite.used` (its value BEFORE this
            // submission) is what tells the deadline message whether to talk
            // about editing or about RSVPing for the first time, and is also
            // what gates the wholesale-clear step below (a first submission has
            // nothing to clear, so it skips straight past it).
            const isEdit = invite.used;
            assertRsvpDeadlineNotPassed(invite.event.rsvpDeadline, isEdit);
            // Guest-supplied name/contact — the whole reason firstName/surname
            // are nullable on Guest (schema.prisma) is that a phone-only import
            // has no name until the guest RSVPs and supplies one here. Computed
            // up front (before any other write) so a required-name rejection
            // fails BEFORE the wholesale-clear/attendance/plus-one writes below
            // start spending round trips, and so the one guest.update this adds
            // can carry every changed field in a single write.
            const nextFirstName = trimToUndefined(data.firstName);
            const nextSurname = trimToUndefined(data.surname);
            const nextEmailRaw = trimToUndefined(data.email);
            const nextPhoneRaw = trimToUndefined(data.phoneNumber);
            const guestUpdateData = {};
            if (nextFirstName !== undefined && nextFirstName !== invite.guest.firstName) {
                guestUpdateData.firstName = nextFirstName;
            }
            if (nextSurname !== undefined && nextSurname !== invite.guest.surname) {
                guestUpdateData.surname = nextSurname;
            }
            // Contact is a separate question from name: a guest imported by
            // phone has no email, and the reason BOTH fields exist on Guest is
            // so the other can be captured here. Unlike
            // guest-validation.util.ts's assertExactlyOneContact (which governs
            // organiser create/update), a guest is deliberately allowed to end
            // up holding both — routing (contactFor/dispatchOne in
            // invite-dispatch.service.ts) is keyed off the Invite's
            // already-fixed deliveryMethod, not re-derived from the guest's
            // contact fields, so an existing invite's delivery is unaffected
            // either way. If a dynamic per-send channel choice is ever built,
            // phone should win when both are present — that's a preference
            // setting, not something to invent here.
            if (nextEmailRaw !== undefined) {
                const normalizedEmail = normalizeEmail(nextEmailRaw);
                assertValidEmail(normalizedEmail);
                if (normalizedEmail !== invite.guest.email)
                    guestUpdateData.email = normalizedEmail;
            }
            if (nextPhoneRaw !== undefined) {
                const normalizedPhone = normalizePhoneToE164(nextPhoneRaw);
                if (normalizedPhone !== invite.guest.phoneNumber)
                    guestUpdateData.phoneNumber = normalizedPhone;
            }
            // Same duplicate rule as guest.service.ts's create/import paths
            // (STEERING: same email/phone on the same event is a duplicate) —
            // only queried when a contact is actually changing, since this is
            // the one extra read this whole block can't avoid.
            if (guestUpdateData.email || guestUpdateData.phoneNumber) {
                const duplicate = await tx.guest.findFirst({
                    where: {
                        eventId: invite.eventId,
                        isArchived: false,
                        id: { not: invite.guestId },
                        OR: [
                            ...(guestUpdateData.email ? [{ email: guestUpdateData.email }] : []),
                            ...(guestUpdateData.phoneNumber ? [{ phoneNumber: guestUpdateData.phoneNumber }] : []),
                        ],
                    },
                    select: { id: true },
                });
                if (duplicate) {
                    throw new HttpError(409, `Another guest on this event is already using this ${guestUpdateData.email ? 'email address' : 'phone number'}.`);
                }
            }
            // Required only when attending, and only when the guest has no name
            // at all yet — an organiser needs to know who's coming, and this is
            // the only moment a phone-only-imported guest is ever asked. A
            // decline needs no name (nothing to seat, nothing to check in), and
            // a guest who already has a name (organiser-entered or from an
            // earlier RSVP) is never re-prompted.
            const finalFirstName = guestUpdateData.firstName ?? invite.guest.firstName;
            if (data.attending && !finalFirstName) {
                throw new HttpError(400, "Please tell us your name so the organiser knows who's coming.");
            }
            if (Object.keys(guestUpdateData).length > 0) {
                await tx.guest.update({ where: { id: invite.guestId }, data: guestUpdateData });
            }
            // Wholesale replace: an edit states the guest's CURRENT intent, not
            // an amendment to history, so whatever this invite (and any
            // plus-ones declared under it) had from an earlier submission is
            // cleared here before being rebuilt fresh below. Skipped entirely
            // on a first submission — nothing to clear, and skipping saves the
            // round trips on the common (first-time) case.
            //
            // Attendance and RsvpResponse have no soft-delete field at all
            // (fact records), so hard-deleting THIS invite's own rows is the
            // only option, not a judgment call. Guest/Invite DO soft-delete, so
            // a replaced plus-one is archived, not deleted — but its now-stale
            // Attendance/InviteEventDay rows are deliberately left in place
            // rather than also hard-deleted: they hang off an archived invite
            // that every live query (findAll, findByGuestIds,
            // countAcceptedInvitesForEvent, attendanceService's own lookups)
            // already excludes, so they're unreachable clutter, not a
            // correctness risk — and avoiding two more round trips per replaced
            // plus-one is exactly the kind of cost this rewrite exists to cut.
            if (isEdit) {
                await tx.attendance.deleteMany({ where: { inviteId: invite.id } });
                await tx.rsvpResponse.deleteMany({ where: { inviteId: invite.id } });
                if (invite.guest.plusOnes.length > 0) {
                    const oldPlusOneInviteIds = invite.guest.plusOnes.flatMap((p) => p.invites.map((i) => i.id));
                    const oldPlusOneGuestIds = invite.guest.plusOnes.map((p) => p.id);
                    await tx.invite.updateMany({ where: { id: { in: oldPlusOneInviteIds } }, data: { isArchived: true } });
                    await tx.guest.updateMany({ where: { id: { in: oldPlusOneGuestIds } }, data: { isArchived: true } });
                }
            }
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
                // Needs the loaded guest (plusOnesAllowed), so this lives here
                // rather than in assertValidSubmission — same two-phase pattern as
                // the day-id check above. The allowance is the guest's OWN value,
                // not another guest's, so naming it in the message is safe.
                const plusOneNames = data.plusOneNames ?? [];
                if (plusOneNames.length > invite.guest.plusOnesAllowed) {
                    throw new HttpError(400, `You can bring up to ${invite.guest.plusOnesAllowed} plus-one(s). Please remove some and try again.`);
                }
                // Batched — same fix as the plus-one section below and
                // bulkCreateWithInvites: a sequential per-day loop of individual
                // creates is what blew the interactive-transaction timeout in
                // testing. No read-back after the write either — createMany's
                // real ids/confirmedAt aren't needed by anything yet (no
                // frontend consumes this response today), and re-querying what
                // was just written is exactly the kind of extra round trip this
                // rewrite is cutting; {inviteId, eventDayId} is enough to say
                // which days were recorded.
                if (attendingDayIds.length > 0) {
                    await tx.attendance.createMany({
                        data: attendingDayIds.map((eventDayId) => ({ inviteId: invite.id, eventDayId })),
                    });
                    attendances.push(...attendingDayIds.map((eventDayId) => ({ inviteId: invite.id, eventDayId })));
                }
                // Each plus-one is a real Guest+Invite pair (mirrors
                // createWithInvite's shape) so check-in works with zero changes to
                // the attendance module — Attendance keys purely on inviteId, never
                // on Guest. The Invite is born already in its terminal state:
                // nobody will ever submit against its token, so there's no PENDING
                // phase to pass through. deliveryMethod is an inert placeholder —
                // never read, because every dispatch/resend/outstanding-invite
                // query excludes plus-ones via hostGuestId by construction.
                // A plus-one attends exactly the days their host attends (v1 has
                // no per-plus-one day selection) and captures name only — no
                // contact, no custom RSVP field answers (out of scope for v1).
                //
                // Batched via createMany (IDs pre-generated client-side), not a
                // per-name loop of individual creates — the same fix
                // bulkCreateWithInvites already applies to guest import, for the
                // same reason: a sequential-round-trip loop over a real (Neon)
                // connection blew the interactive-transaction timeout in testing
                // with as few as 2 plus-ones across 2 days.
                if (plusOneNames.length > 0) {
                    const plusOneGuestIds = plusOneNames.map(() => crypto.randomUUID());
                    const plusOneInviteIds = plusOneNames.map(() => crypto.randomUUID());
                    await tx.guest.createMany({
                        data: plusOneNames.map((name, i) => ({
                            id: plusOneGuestIds[i],
                            eventId: invite.eventId,
                            firstName: name,
                            surname: null,
                            email: null,
                            phoneNumber: null,
                            hostGuestId: invite.guestId,
                            plusOnesAllowed: 0,
                            isArchived: false,
                        })),
                    });
                    await tx.invite.createMany({
                        data: plusOneNames.map((_, i) => ({
                            id: plusOneInviteIds[i],
                            eventId: invite.eventId,
                            guestId: plusOneGuestIds[i],
                            token: crypto.randomBytes(32).toString('hex'),
                            status: 'ACCEPTED',
                            used: true,
                            usedAt: new Date(),
                            deliveryMethod: 'EMAIL',
                            expiresAt: null,
                            isArchived: false,
                            createdBy: GUEST_ACTOR,
                            updatedBy: GUEST_ACTOR,
                        })),
                    });
                    await tx.inviteEventDay.createMany({
                        data: plusOneInviteIds.flatMap((inviteId) => attendingDayIds.map((eventDayId) => ({ inviteId, eventDayId }))),
                    });
                    const plusOneAttendanceRows = plusOneInviteIds.flatMap((inviteId) => attendingDayIds.map((eventDayId) => ({ inviteId, eventDayId })));
                    await tx.attendance.createMany({ data: plusOneAttendanceRows });
                    attendances.push(...plusOneAttendanceRows);
                }
            }
            const rsvpResponses = [];
            const submittedResponses = data.rsvpResponses ?? [];
            if (submittedResponses.length > 0) {
                const validFieldIds = new Set(invite.event.rsvpFields.map((f) => f.id));
                for (const response of submittedResponses) {
                    if (!validFieldIds.has(response.rsvpFieldId)) {
                        // 400 — same reasoning as the day-id check above: a well-shaped
                        // but non-existent/wrong-event rsvpFieldId is a malformed
                        // submission (stale page or tampered request), not something to
                        // let fall through to a foreign-key violation at write time.
                        throw new HttpError(400, "One of your answers isn't part of this invitation. Please refresh the page and try again.");
                    }
                }
                // Batched, no read-back — same reasoning as the attendance
                // sections above.
                const responseRows = submittedResponses.map((response) => ({
                    inviteId: invite.id,
                    rsvpFieldId: response.rsvpFieldId,
                    value: response.value,
                }));
                await tx.rsvpResponse.createMany({ data: responseRows });
                rsvpResponses.push(...responseRows);
            }
            // Paid-event decision: once a purchase exists for this invite, its
            // ticket/quantity are immutable through this edit flow — never
            // replaced, never deleted, regardless of whether it ended up PAID,
            // PENDING, FAILED, or EXPIRED. Changing ticket selection isn't
            // supported (contact the organiser); a resubmission that repeats
            // the SAME ticket/quantity is a no-op that returns the purchase
            // as-is — retrying or checking on its PAYMENT is a separate,
            // dedicated flow (rsvp.service.ts's retryTicketPayment /
            // confirmTicketPayment below), not something resubmitting the
            // whole RSVP form triggers. No separate lookup here —
            // `invite.ticketPurchases` already came back with the initial fetch.
            const existingPurchase = invite.ticketPurchases[0] ?? null;
            let ticketPurchase = existingPurchase;
            let freshReservation = null;
            let guestEmailForReservation = null;
            if (data.ticketId && data.attending) {
                if (existingPurchase) {
                    const requestedQuantity = data.ticketQuantity ?? 1;
                    if (existingPurchase.ticketId !== data.ticketId || existingPurchase.quantity !== requestedQuantity) {
                        throw new HttpError(409, "You've already started a ticket purchase for this event, and changing your ticket selection isn't supported yet. Contact the organiser to make changes.");
                    }
                    // Identical resubmission of what was already started/bought — no-op.
                }
                else {
                    const ticket = invite.event.tickets.find((t) => t.id === data.ticketId);
                    // 409 — a genuine state conflict: the ticket exists, but its
                    // current state (archived / marked unavailable) conflicts with
                    // trying to purchase it right now.
                    if (!ticket || ticket.isArchived || !ticket.isAvailable) {
                        throw new HttpError(409, 'This ticket type is no longer available. Please choose a different option or contact the organiser.');
                    }
                    const quantity = data.ticketQuantity ?? 1;
                    // A ticket purchase needs somewhere to send the Paystack
                    // checkout link and receipt — a guest imported by phone alone
                    // has no email until they supply one, same moment as any
                    // other contact-detail gap this form fills.
                    guestEmailForReservation = guestUpdateData.email ?? invite.guest.email;
                    if (!guestEmailForReservation) {
                        throw new HttpError(400, 'An email address is required to purchase a ticket — please provide one above.');
                    }
                    // No totalQuantity/soldCount pre-check here — that would be
                    // exactly the read-then-check-then-write race this design
                    // exists to avoid. ticketPurchaseService.reserveWithinTransaction's
                    // atomic guard (a single conditional UPDATE) is the real,
                    // database-level check, and throws HttpError(409) itself if
                    // there isn't room.
                    freshReservation = await ticketPurchaseService.reserveWithinTransaction(tx, {
                        tenantId: invite.event.tenantId,
                        eventId: invite.eventId,
                        inviteId: invite.id,
                        ticket: { id: ticket.id, price: ticket.price, currency: ticket.currency },
                        quantity,
                    });
                    ticketPurchase = {
                        id: freshReservation.purchaseId,
                        ticketId: ticket.id,
                        inviteId: invite.id,
                        quantity,
                        status: 'PENDING',
                    };
                }
            }
            // A guest declining while a PAID purchase stands is exactly the
            // case with no automated resolution — the RSVP change itself goes
            // through (their attendance/responses/plus-ones are already
            // cleared above), but the money doesn't move on its own. A
            // PENDING/FAILED/EXPIRED purchase isn't paid yet, so there's
            // nothing to refund-notice about — it simply lapses via its own
            // hold expiry if nobody ever completes it.
            const refundNotice = !data.attending && existingPurchase?.status === 'PAID'
                ? "You have a paid ticket for this event. Declining doesn't automatically refund it — contact the organiser directly about a refund."
                : null;
            const updatedInvite = await tx.invite.update({
                where: { id: invite.id },
                data: {
                    used: true,
                    usedAt: new Date(),
                    status: data.attending ? 'ACCEPTED' : 'DECLINED',
                    updatedBy: GUEST_ACTOR,
                },
            });
            return { invite: updatedInvite, attendances, rsvpResponses, ticketPurchase, refundNotice, freshReservation, guestEmailForReservation };
        }, {
            // Every write in this transaction is already batched to a FIXED
            // number of round trips regardless of day/field/plus-one count —
            // that part of the fix is real and stays. What's left is a
            // different problem: testing against the real (Neon) dev database
            // measured the first interactive transaction after a period of
            // inactivity taking 6-6.5s end-to-end — consistent with a
            // serverless Postgres connection's cold-start cost landing inside
            // the transaction window, not with round-trip count (a WARM
            // connection completed the same shape of transaction, editing 4
            // days/3 fields/2 plus-ones/a ticket purchase down to fewer of
            // each, well inside the default). Batching can't remove a one-time
            // connection cost that's paid regardless of how few queries follow
            // it, so raising the timeout here is the genuine fix for THIS
            // failure mode, not a substitute for the batching above — unlike
            // bulkCreateWithInvites's original timeout, which scaled with row
            // count and had no fixed floor to hit.
            timeout: 15000,
            // Added for Ticketing & Payments — maxWait (time allowed to
            // ACQUIRE a connection and START the transaction, distinct from
            // `timeout` above which bounds the transaction's own execution
            // once running) wasn't set here before, and Prisma's default
            // (~2s) is tuned for a warm pool. It didn't surface until this
            // batch's concurrency testing genuinely opened two simultaneous
            // interactive transactions against the same serverless
            // connection — P2028, "unable to start a transaction in the given
            // time" — which a single request never triggers. Two guests
            // racing for the last unit of a ticket is exactly the scenario
            // this whole file exists to get right, so this couldn't be left
            // as a latent gap.
            maxWait: 10000,
        });
        const { freshReservation, guestEmailForReservation, ...rest } = result;
        // No ticket reservation happened this call — the common case
        // (declining, or a no-op resubmission of an existing purchase).
        if (!freshReservation) {
            return { ...rest, paymentAction: null };
        }
        // The one external network call in this whole flow — deliberately
        // AFTER the transaction above has already committed. Failure here
        // is handled by startPaystackCheckout itself (it releases the hold
        // and marks the purchase FAILED via ticketPurchaseService.
        // failPayment), so this RSVP submission still succeeds either way —
        // only paymentAction tells the caller whether checkout is ready or
        // needs a retry.
        const checkout = await ticketPurchaseService.startPaystackCheckout({
            paymentRef: freshReservation.paymentRef,
            totalChargeCents: freshReservation.totalChargeCents,
            platformChargeCents: freshReservation.platformChargeCents,
            // Asserted non-null: reaching this point required
            // guestEmailForPurchase to have been present inside the
            // transaction (submit() throws HttpError(400) beforehand
            // otherwise), and that's exactly what guestEmailForReservation is.
            guestEmail: guestEmailForReservation,
            subaccountCode: freshReservation.subaccountCode,
            callbackUrl: `${process.env.FRONTEND_BASE_URL}/rsvp/payment-callback?token=${encodeURIComponent(data.token)}`,
        });
        if ('failed' in checkout) {
            return { ...rest, paymentAction: { type: 'retry_needed', reason: checkout.reason } };
        }
        return { ...rest, paymentAction: { type: 'redirect', authorizationUrl: checkout.authorizationUrl } };
    },
    // ── RETRY — guest-facing, token-scoped. Re-initiates payment for an
    // existing FAILED/EXPIRED purchase on this invite without touching
    // any other RSVP state (attendance, responses, plus-ones). Does
    // nothing to (and returns the current status of) a PENDING or PAID
    // purchase — see ticketPurchaseService.retryPayment's own comment.
    retryTicketPayment: async (token) => {
        const invite = await inviteRepository.findByToken(token);
        if (!invite) {
            throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
        }
        const purchase = invite.ticketPurchases[0];
        if (!purchase) {
            throw new HttpError(404, 'There is no ticket purchase to retry for this invitation.');
        }
        const ticket = invite.event.tickets.find((t) => t.id === purchase.ticketId);
        if (!ticket) {
            throw new HttpError(404, 'This ticket type is no longer available.');
        }
        const outcome = await ticketPurchaseService.retryPayment({
            purchaseId: purchase.id,
            ticketId: ticket.id,
            ticketPrice: ticket.price,
            currency: ticket.currency,
            quantity: purchase.quantity,
            tenantId: invite.event.tenantId,
        });
        if (outcome.status !== 'RETRYING') {
            return { status: outcome.status, authorizationUrl: null };
        }
        const guestEmail = invite.guest.email;
        if (!guestEmail) {
            throw new HttpError(400, 'An email address is required to purchase a ticket — please add one via the RSVP form first.');
        }
        const checkout = await ticketPurchaseService.startPaystackCheckout({
            paymentRef: outcome.paymentRef,
            totalChargeCents: outcome.totalChargeCents,
            platformChargeCents: outcome.platformChargeCents,
            guestEmail,
            subaccountCode: outcome.subaccountCode,
            callbackUrl: `${process.env.FRONTEND_BASE_URL}/rsvp/payment-callback?token=${encodeURIComponent(token)}`,
        });
        if ('failed' in checkout) {
            return { status: 'FAILED', authorizationUrl: null, reason: checkout.reason };
        }
        return { status: 'RETRYING', authorizationUrl: checkout.authorizationUrl };
    },
    // ── CONFIRM — guest-facing, token-scoped. Called from the Paystack
    // callback landing page. NEVER treats the callback's own return alone
    // as proof of payment — see ticketPurchaseService.reconcile's comment.
    // This just resolves the token to a purchase id and delegates.
    confirmTicketPayment: async (token) => {
        const invite = await inviteRepository.findByToken(token);
        if (!invite) {
            throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
        }
        const purchase = invite.ticketPurchases[0];
        if (!purchase) {
            throw new HttpError(404, 'There is no ticket purchase for this invitation.');
        }
        return ticketPurchaseService.reconcile(purchase.id);
    },
};
//# sourceMappingURL=rsvp.service.js.map