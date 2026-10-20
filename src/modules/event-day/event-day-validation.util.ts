import { Prisma } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventDayRepository, type EventDayWrite, type EventDayPatch } from './event-day.repository.js';
import { resolveDayVenueForCreate, resolveDayVenueForUpdate, type DayVenueInput } from './event-day-venue.util.js';
import { parseClientDateTime, isSameUtcDate } from '../../shared/utils/date-input.util.js';

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
    throw new HttpError(409, duplicateDayLabelMessage(conflict.label));
  }
};

export const duplicateDayLabelMessage = (label: string): string =>
  `This event already has a day labeled '${label}'. Day labels must be unique.`;

// The same rule over a whole list of days at once (the wizard's materialize
// and the full event update): the first label repeated, ignoring case.
export const findDuplicateDayLabel = (labels: string[]): string | null => {
  const seen = new Set<string>();
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    if (seen.has(normalized)) return label;
    seen.add(normalized);
  }
  return null;
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
  if (!trimmed) throw new HttpError(422, 'Each event day needs a label, e.g. "Day 1: Ceremony".');
  return trimmed;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}/;

export const requireDayDate = (date: unknown, label: string): Date => {
  if (typeof date !== 'string' || !DATE_ONLY.test(date.trim())) {
    throw new HttpError(422, `'${label}' needs a date.`);
  }
  const parsed = parseClientDateTime(date.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, `'${label}' needs a valid date, and '${date}' isn't one.`);
  }
  return parsed;
};

// A day's end time, when it has one, must come after its start time — the
// wizard's rule, same words. Only checked when both are set: either alone
// is fine. Judged on the day an update leaves behind (stored values fill
// in what the request omits), like the venue. Used by event-day.service.ts
// and the wizard's materialize path.
export const assertDayTimesInOrder = (startTime: Date | null, endTime: Date | null, label: string): void => {
  if (startTime && endTime && endTime.getTime() <= startTime.getTime()) {
    throw new HttpError(422, `The end time of '${label}' must be after its start time.`);
  }
};

// ─────────────────────────────────────────
//  A DAY'S DATE CAN'T BE IN THE PAST — new or changed dates only
//
//  The wizard refuses a date before the organiser's own today. Events have
//  no time zone (STEERING "Known gaps") and the server knows only UTC, so
//  the server allows one day of slack: a date earlier than UTC today minus
//  one day is refused. An organiser behind UTC (whose "today" is still UTC
//  yesterday) is never refused for picking their own today.
//
//  Only a date that is new or changed is judged. A saved day whose event
//  has already happened keeps its date and stays editable: re-sending it
//  unchanged is never refused.
// ─────────────────────────────────────────
export const EVENT_DAY_DATE_IN_PAST = 'EVENT_DAY_DATE_IN_PAST';

export const earliestAllowedDayDate = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));

export const assertDayDateNotPast = (date: Date, label: string, now: Date = new Date()): void => {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (day < earliestAllowedDayDate(now).getTime()) {
    throw new HttpError(422, `The date of '${label}' has already passed. Choose today or a later date.`, EVENT_DAY_DATE_IN_PAST);
  }
};

// startTime/endTime are optional; an explicit null (or blank) clears one.
// Never new Date(null) — that is 1970-01-01, the bug the old repository
// comment described.
export const optionalDayDateTime = (value: unknown): Date | null =>
  value ? parseClientDateTime(value as string) : null;

export interface DayInput extends DayVenueInput {
  label?: unknown;
  date?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

// Every rule for a NEW day's own fields, in one place: POST .../days, the
// wizard's materialize and the full event update. Label uniqueness is the
// caller's (it needs the event's other days).
export const resolveNewDay = (data: DayInput): EventDayWrite => {
  const label = requireDayLabel(data.label);
  const date = requireDayDate(data.date, label);
  assertDayDateNotPast(date, label);
  const venue = resolveDayVenueForCreate(data, label);
  const startTime = optionalDayDateTime(data.startTime);
  const endTime = optionalDayDateTime(data.endTime);
  assertDayTimesInOrder(startTime, endTime, label);
  return { label, date, startTime, endTime, venue };
};

export interface StoredDay {
  label: string;
  date: Date;
  startTime: Date | null;
  endTime: Date | null;
  location: string | null;
  address: string | null;
  latitude: Prisma.Decimal | number | null;
  longitude: Prisma.Decimal | number | null;
}

// Every rule for a change to a saved day, judged on the day it leaves
// behind: PUT .../days/:id and the full event update. Omitted fields keep
// their stored value. Label uniqueness is the caller's.
export const resolveDayChanges = (data: DayInput, existing: StoredDay): EventDayPatch => {
  const label = data.label !== undefined ? requireDayLabel(data.label) : undefined;
  const effectiveLabel = label ?? existing.label;
  const date = data.date !== undefined ? requireDayDate(data.date, effectiveLabel) : undefined;
  if (date !== undefined && !isSameUtcDate(date, existing.date)) assertDayDateNotPast(date, effectiveLabel);
  const venue = resolveDayVenueForUpdate(data, existing, effectiveLabel);
  const startTime = data.startTime !== undefined ? optionalDayDateTime(data.startTime) : undefined;
  const endTime = data.endTime !== undefined ? optionalDayDateTime(data.endTime) : undefined;
  assertDayTimesInOrder(
    startTime !== undefined ? startTime : existing.startTime,
    endTime !== undefined ? endTime : existing.endTime,
    effectiveLabel
  );
  return {
    ...(label !== undefined && { label }),
    ...(date !== undefined && { date }),
    ...(startTime !== undefined && { startTime }),
    ...(endTime !== undefined && { endTime }),
    venue,
  };
};
