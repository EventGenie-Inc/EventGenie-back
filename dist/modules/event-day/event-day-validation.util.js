import { Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventDayRepository } from './event-day.repository.js';
// EventDay.label must be unique per event so the import engine's Day
// column (and any human reading a spreadsheet) never faces an ambiguous
// label. The DB constraint (@@unique([eventId, label])) is case-sensitive
// — it's a safety net against races, not the real check: "Saturday" and
// "saturday" are the same ambiguity to a human, so this comparison is
// case-insensitive, matching the import engine's existing day-matching
// convention (guest-import.engine.ts).
export const assertNoDuplicateDayLabel = async (eventId, label, excludeDayId) => {
    const days = await eventDayRepository.findAll(eventId);
    const normalized = label.trim().toLowerCase();
    const conflict = days.find((d) => d.id !== excludeDayId && d.label.trim().toLowerCase() === normalized);
    if (conflict) {
        throw new HttpError(409, `This event already has a day labeled '${conflict.label}' — day labels must be unique per event`);
    }
};
// Defense-in-depth for the race the pre-check above can't fully close
// (two concurrent requests on the same existing event) — translates the
// raw DB unique-constraint violation into the same friendly HttpError
// instead of letting a bare P2002 reach the client.
export const isDayLabelUniqueViolation = (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
//# sourceMappingURL=event-day-validation.util.js.map