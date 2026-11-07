import { type EventStatus } from '@prisma/client';
import { hasDeadlinePassed } from '../event/event-rsvp-deadline.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';

// The gates a guest's write through their invitation passes: RSVP submit
// (rsvp.service.ts) and a document upload (guest-document.service.ts).
// Moved here unchanged from rsvp.service.ts so both can use them without
// an import cycle.

// Guest-facing wording for the same three blocked statuses invites use
// (COMPLETED/CANCELLED read fine to a guest as-is); DRAFT gets its own
// text since "publish it before sending invitations" is organiser
// language a guest should never see. In practice a guest can only ever
// hold a token for an event that WAS published (invites can't be sent
// to a draft event — Task 3), so this branch is defensive, not reachable.
export const RSVP_BLOCK_MESSAGES: Partial<Record<EventStatus, string>> = {
  DRAFT: 'This event is not yet open for RSVPs.',
  COMPLETED: 'This event has already taken place.',
  CANCELLED: 'This event has been cancelled.',
};

// An archived event, to its guests: one neutral line, never "archived",
// and nothing about the event (validate shows nothing of it; submit and
// the ticket quote change nothing). 410 like an expired link: the
// invitation existed and is gone. Restoring the event opens it again.
export const EVENT_NO_LONGER_AVAILABLE_MESSAGE = 'This event is no longer available.';

export const assertEventNotArchived = (event: { isArchived: boolean }): void => {
  if (event.isArchived) throw new HttpError(410, EVENT_NO_LONGER_AVAILABLE_MESSAGE);
};

// 403 — the guest is correctly identified (their token is valid), but
// the event's current state means RSVPs aren't accepted right now. Not
// a 409: nothing about THIS submission conflicts with anything; the
// door is simply closed regardless of what they submit.
export const assertEventAcceptsRsvp = (effectiveStatus: EventStatus): void => {
  if (effectiveStatus === 'PUBLISHED') return;
  throw new HttpError(403, RSVP_BLOCK_MESSAGES[effectiveStatus] ?? 'This event is not currently accepting RSVPs.');
};

// rsvpDeadline is independent of Event.status (Batch A Task 1) — an event
// can be perfectly PUBLISHED and still have RSVP submission closed. Only
// guest self-service is affected; organiser guest management in
// guest.service.ts never checks this. A date-only deadline closes at the
// end of its day (event-rsvp-deadline.util.ts).
export const isRsvpDeadlinePassed = (rsvpDeadline: Date | null): boolean => hasDeadlinePassed(rsvpDeadline);

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
export const assertRsvpDeadlineNotPassed = (rsvpDeadline: Date | null, isEdit: boolean): void => {
  if (isRsvpDeadlinePassed(rsvpDeadline)) {
    const deadlineText = formatGuestDate(rsvpDeadline as Date);
    throw new HttpError(
      410,
      isEdit
        ? `Responses for this event closed on ${deadlineText}, and your response stands. Contact the organiser if you need to change it.`
        : `Responses for this event closed on ${deadlineText}. Contact the organiser if you still need to RSVP.`
    );
  }
};
