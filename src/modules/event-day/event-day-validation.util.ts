import { Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventDayRepository } from './event-day.repository.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';

// EventDay.label must be unique per event so the import engine's Day
// column (and any human reading a spreadsheet) never faces an ambiguous
// label. The DB constraint (@@unique([eventId, label])) is case-sensitive
// — it's a safety net against races, not the real check: "Saturday" and
// "saturday" are the same ambiguity to a human, so this comparison is
// case-insensitive, matching the import engine's existing day-matching
// convention (guest-import.engine.ts).
export const assertNoDuplicateDayLabel = async (
  eventId: string,
  label: string,
  excludeDayId?: string
): Promise<void> => {
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
export const isDayLabelUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Required-field checks for a day's own fields (the venue has its own,
// event-day-venue.util.ts). 422 — a well-formed request missing a value
// the organiser must supply — with the day named where there is one, so a
// multi-day wizard save says WHICH row to fix. Used by event-day.service.ts
// and the wizard's materialize path alike.
export const requireDayLabel = (label: unknown): string => {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed) throw new HttpError(422, 'Each event day needs a label, e.g. "Day 1 — Ceremony".');
  return trimmed;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}/;

export const requireDayDate = (date: unknown, label: string): Date => {
  if (typeof date !== 'string' || !DATE_ONLY.test(date.trim())) {
    throw new HttpError(422, `'${label}' needs a date.`);
  }
  const parsed = parseClientDateTime(date.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, `'${label}' needs a valid date — '${date}' isn't one.`);
  }
  return parsed;
};
