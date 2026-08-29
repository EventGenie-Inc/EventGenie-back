import {} from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
// A day without an explicit endTime is treated as ending at the close
// of its calendar date. EventDay.date is a @db.Date column, which
// Prisma round-trips as UTC midnight, so "end of day" is computed in
// UTC to stay consistent with that value.
const endOfDayUtc = (date) => {
    const end = new Date(date);
    end.setUTCHours(23, 59, 59, 999);
    return end;
};
export const resolveEffectiveStatus = (event) => {
    // Cancellation wins — a cancelled event never becomes "completed",
    // no matter how far in the past its days are.
    if (event.status === 'CANCELLED')
        return 'CANCELLED';
    if (event.status === 'DRAFT')
        return 'DRAFT';
    if (event.status === 'PUBLISHED' && event.eventDays.length > 0) {
        const lastDay = event.eventDays.reduce((latest, day) => (day.date > latest.date ? day : latest));
        const lastDayEnd = lastDay.endTime ?? endOfDayUtc(lastDay.date);
        if (lastDayEnd < new Date())
            return 'COMPLETED';
    }
    return event.status;
};
// Presenter — swaps event.status for its effective value before the
// object goes out to a client. Never persisted; only the in-memory
// response is affected.
export const withEffectiveStatus = (event) => ({
    ...event,
    status: resolveEffectiveStatus(event),
});
// ─────────────────────────────────────────
//  OUTBOUND-ACTION GATE
//
//  Shared by every organiser-facing action that must not reach a
//  guest unless the event is actually live: invite send/resend and
//  the share-link lookup. Each blocked status gets its own message —
//  these are surfaced directly to a non-technical organiser by the
//  frontend, so "event is not published" for all three reads as a
//  bug report waiting to happen.
// ─────────────────────────────────────────
const OUTBOUND_BLOCK_MESSAGES = {
    DRAFT: 'This event is still a draft. Publish it before sending invitations.',
    COMPLETED: 'This event has already taken place.',
    CANCELLED: 'This event has been cancelled.',
};
// Expects an already-effective status (i.e. event.status as returned
// by eventService.getById/getAll, which apply withEffectiveStatus).
export const assertEventIsPublished = (effectiveStatus) => {
    if (effectiveStatus === 'PUBLISHED')
        return;
    throw new HttpError(409, OUTBOUND_BLOCK_MESSAGES[effectiveStatus] ?? `This event is not published (current status: ${effectiveStatus}).`);
};
//# sourceMappingURL=event-status.util.js.map