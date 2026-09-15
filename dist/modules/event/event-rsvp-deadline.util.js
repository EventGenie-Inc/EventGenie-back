import { HttpError } from '../../shared/errors/http-error.js';
import { endOfDayUtc } from './event-status.util.js';
// The deadline is independent of Event.status (see schema comment) — this
// util only checks the deadline value itself is sane, never event.status.
export const assertValidRsvpDeadline = (rsvpDeadline, eventDays, options) => {
    if (rsvpDeadline === undefined || rsvpDeadline === null)
        return;
    if (Number.isNaN(rsvpDeadline.getTime())) {
        throw new HttpError(400, "The RSVP deadline isn't a valid date.");
    }
    // Only enforced on creation (see options.rejectPast at call sites) — an
    // organiser deliberately setting a deadline to "now" on an existing
    // event to force-close RSVPs early is a legitimate action, so this is
    // not checked on update. Setting one in the past at creation time can't
    // reflect real intent (RSVPs would be closed before the event even
    // starts accepting them) and is almost always a typo.
    if (options.rejectPast && rsvpDeadline < new Date()) {
        throw new HttpError(400, 'The RSVP deadline is already in the past. Pick a future date and time, or leave it blank to accept RSVPs until the event happens.');
    }
    // No event days yet (e.g. a fresh direct-POST draft) — nothing to
    // compare against. The event-day-removal edge case (archiving the day
    // that used to be "last" and stranding the deadline after the new last
    // day) is not re-validated here; see the batch report.
    if (eventDays.length === 0)
        return;
    const lastDay = eventDays.reduce((latest, day) => (day.date > latest.date ? day : latest));
    const lastDayEnd = lastDay.endTime ?? endOfDayUtc(lastDay.date);
    if (rsvpDeadline > lastDayEnd) {
        throw new HttpError(400, "The RSVP deadline can't be after the event's last day — an RSVP deadline after the event has ended is meaningless.");
    }
};
//# sourceMappingURL=event-rsvp-deadline.util.js.map