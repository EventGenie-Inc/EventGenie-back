import { type EventStatus } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../../shared/prisma/prisma.client.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { ticketRepository } from '../ticket/ticket.repository.js';
import { ticketPurchaseRepository } from '../ticket-purchase/ticket-purchase.repository.js';
import { type SubmitRsvpDto } from './rsvp.types.js';
import { resolveEffectiveStatus, withEffectiveStatus } from '../event/event-status.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';

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
const RSVP_BLOCK_MESSAGES: Partial<Record<EventStatus, string>> = {
  DRAFT: 'This event is not yet open for RSVPs.',
  COMPLETED: 'This event has already taken place.',
  CANCELLED: 'This event has been cancelled.',
};

// 403 — the guest is correctly identified (their token is valid), but
// the event's current state means RSVPs aren't accepted right now. Not
// a 409: nothing about THIS submission conflicts with anything; the
// door is simply closed regardless of what they submit.
const assertEventAcceptsRsvp = (effectiveStatus: EventStatus): void => {
  if (effectiveStatus === 'PUBLISHED') return;
  throw new HttpError(403, RSVP_BLOCK_MESSAGES[effectiveStatus] ?? 'This event is not currently accepting RSVPs.');
};

// rsvpDeadline is independent of Event.status (Batch A Task 1) — an event
// can be perfectly PUBLISHED and still have RSVP submission closed. Only
// guest self-service is affected; organiser guest management in
// guest.service.ts never checks this.
const isRsvpDeadlinePassed = (rsvpDeadline: Date | null): boolean =>
  !!rsvpDeadline && rsvpDeadline < new Date();

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
const assertRsvpDeadlineNotPassed = (rsvpDeadline: Date | null, isEdit: boolean): void => {
  if (isRsvpDeadlinePassed(rsvpDeadline)) {
    const deadlineText = formatGuestDate(rsvpDeadline as Date);
    throw new HttpError(
      410,
      isEdit
        ? `Responses for this event closed on ${deadlineText}. Your existing response stands — contact the organiser if you need to change it.`
        : `Responses for this event closed on ${deadlineText}. Contact the organiser if you still need to RSVP.`
    );
  }
};

// Guest RSVP submissions are the first writes in this codebase performed by
// a non-platform actor. Invite.updatedBy is a plain String (not an FK to
// User), so this sentinel documents the convention for guest-originated writes.
const GUEST_ACTOR = 'guest-rsvp';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isValidRsvpResponseShape = (value: unknown): value is { rsvpFieldId: string; value: string } =>
  typeof value === 'object' &&
  value !== null &&
  isNonEmptyString((value as Record<string, unknown>)['rsvpFieldId']) &&
  typeof (value as Record<string, unknown>)['value'] === 'string';

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
const assertValidSubmission = (data: SubmitRsvpDto): void => {
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
};

export const rsvpService = {

  // Public, unauthenticated read — returns flags rather than throwing on
  // invalid state, since the caller is a guest's browser rendering a form.
  validate: async (token: string) => {
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
      // Added for the edit form to prefill from — a guest revisiting
      // their link (isUsed: true, deadline not passed) needs to see what
      // they said last time, not a blank form. Additive only; nothing
      // above this line changed shape.
      attendingDayIds: invite.attendances.map((a) => a.eventDayId),
      rsvpResponses: invite.rsvpResponses.map((r) => ({ rsvpFieldId: r.rsvpFieldId, value: r.value })),
      plusOneNames: invite.guest.plusOnes.map((p) => p.firstName),
      ticketPurchase: invite.ticketPurchases[0] ?? null,
    };
  },

  submit: (data: SubmitRsvpDto) => {
    assertValidSubmission(data);

    return prisma.$transaction(async (tx) => {
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
          throw new HttpError(
            400,
            `You can bring up to ${invite.guest.plusOnesAllowed} plus-one(s). Please remove some and try again.`
          );
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
              id: plusOneGuestIds[i]!,
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
              id: plusOneInviteIds[i]!,
              eventId: invite.eventId,
              guestId: plusOneGuestIds[i]!,
              token: crypto.randomBytes(32).toString('hex'),
              status: 'ACCEPTED' as const,
              used: true,
              usedAt: new Date(),
              deliveryMethod: 'EMAIL' as const,
              expiresAt: null,
              isArchived: false,
              createdBy: GUEST_ACTOR,
              updatedBy: GUEST_ACTOR,
            })),
          });

          await tx.inviteEventDay.createMany({
            data: plusOneInviteIds.flatMap((inviteId) =>
              attendingDayIds.map((eventDayId) => ({ inviteId, eventDayId }))
            ),
          });

          const plusOneAttendanceRows = plusOneInviteIds.flatMap((inviteId) =>
            attendingDayIds.map((eventDayId) => ({ inviteId, eventDayId }))
          );
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

      // Paid-event decision: once a ticket is purchased, the purchase is
      // immutable through this edit flow — it is never replaced, and
      // never deleted. Refunds aren't built (payments aren't built), so
      // (a) blocking all further edits or (c) silently orphaning/creating
      // a second purchase were the alternatives; both are worse than
      // simply freezing the one thing this system can't safely change
      // while leaving everything else (attendance, responses, plus-ones,
      // even accept/decline itself) fully editable. A resubmission that
      // repeats the SAME ticket/quantity is treated as a no-op (the
      // common case — an edit form resending what it was prefilled with);
      // one that asks for something different is rejected with a specific
      // reason, rather than silently ignored. No separate lookup here —
      // `invite.ticketPurchases` already came back with the initial fetch.
      const existingPurchase = invite.ticketPurchases[0] ?? null;
      let ticketPurchase = existingPurchase;

      if (data.ticketId && data.attending) {
        if (existingPurchase) {
          const requestedQuantity = data.ticketQuantity ?? 1;
          if (existingPurchase.ticketId !== data.ticketId || existingPurchase.quantity !== requestedQuantity) {
            throw new HttpError(
              409,
              "You've already purchased a ticket for this event, and changing your ticket selection isn't supported yet. Contact the organiser to make changes."
            );
          }
          // Identical resubmission of what was already bought — no-op.
        } else {
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

          ticketPurchase = await ticketPurchaseRepository.create(
            {
              ticketId: ticket.id,
              inviteId: invite.id,
              quantity,
              totalPaid,
              currency: ticket.currency,
              ...(data.paymentRef !== undefined && { paymentRef: data.paymentRef }),
            },
            tx
          );

          await ticketRepository.incrementSoldCount(ticket.id, quantity, tx);
        }
      }

      // A guest declining while a purchase still stands is exactly the
      // case with no automated resolution — the RSVP change itself goes
      // through (their attendance/responses/plus-ones are already
      // cleared above), but the money doesn't move on its own.
      const refundNotice = !data.attending && existingPurchase
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

      return { invite: updatedInvite, attendances, rsvpResponses, ticketPurchase, refundNotice };
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
    });
  },
};
