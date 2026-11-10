import { type ReminderSchedulePreset } from './reminder-schedule.types.js';

// ─────────────────────────────────────────
//  SCHEDULED REMINDER TIMES — stored in UTC, entered and shown in South
//  African time
//
//  South Africa is UTC+2 all year (no daylight saving), so the conversion
//  is a fixed two hours, never a lookup.
//
//  This is deliberately unlike "Dates" in STEERING, where an offset-less
//  string is literal UTC: a reminder goes out at a real moment, so
//  "09:00" must mean 09:00 in South Africa (07:00 UTC). The event's own
//  values (RSVP deadline, day start) are still literal UTC clocks, which is
//  how the organiser typed them; to compare a reminder with them the
//  reminder is read as its South African wall clock (wallClock). That reads
//  "RSVP by 25 October" as the end of 25 October in South Africa, and is
//  never more lenient than comparing the instants (the wall clock is two
//  hours ahead), so a reminder can't land after replies close.
// ─────────────────────────────────────────

export const SA_TIME_ZONE = 'Africa/Johannesburg';
export const SA_OFFSET_MS = 2 * 60 * 60 * 1000;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// "2026-11-20T09:00" (South African time) -> the instant, or null if it
// isn't one (wrong shape, or a date like 31 February).
export const parseSaLocal = (value: string): Date | null => {
  const m = LOCAL_DATE_TIME.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (wall.getUTCFullYear() !== y || wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return new Date(wall.getTime() - SA_OFFSET_MS);
};

// The instant as South African wall-clock components, held in a Date's UTC
// fields: what the organiser reads, and what is compared with the event's
// own literal-UTC values.
export const wallClock = (at: Date): Date => new Date(at.getTime() + SA_OFFSET_MS);

// "2026-11-20T09:00", South African time.
export const formatSaLocal = (at: Date): string => wallClock(at).toISOString().slice(0, 16);

// A preset's time from `now`, to the minute (seconds dropped). A month is
// a calendar month in South Africa, the day kept, or the month's last day
// when it has fewer (31 January -> 28 or 29 February).
export const presetSendAt = (preset: Exclude<ReminderSchedulePreset, 'CUSTOM'>, now: Date): Date => {
  const wall = wallClock(now);
  wall.setUTCSeconds(0, 0);
  if (preset === 'IN_1_DAY') wall.setUTCDate(wall.getUTCDate() + 1);
  else if (preset === 'IN_1_WEEK') wall.setUTCDate(wall.getUTCDate() + 7);
  else {
    const day = wall.getUTCDate();
    wall.setUTCDate(1);
    wall.setUTCMonth(wall.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
    wall.setUTCDate(Math.min(day, lastDay));
  }
  return new Date(wall.getTime() - SA_OFFSET_MS);
};
