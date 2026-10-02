// ─────────────────────────────────────────
//  CLIENT DATE INPUT — OFFSET-LESS MEANS UTC
//
//  The frontend sends organiser-picked dates and times as ISO strings with
//  no offset (`2026-09-19T23:59:59`, `2026-09-19T18:00:00`) and reads them
//  back assuming they were stored as the same literal UTC clock value
//  (event-display.util.ts's rsvpDeadlineLabel, the wizard's extractTime).
//
//  JavaScript does NOT do that: `new Date('2026-09-19T23:59:59')` is read as
//  the SERVER'S LOCAL time. On a UTC server the two agree, which is why this
//  never showed on production hosting; on a server at any other offset the
//  same request stored a different instant, so a deadline picked as
//  "19 September" could be stored as 20 September and told to guests that
//  way. Every place a client string becomes a Date goes through this instead
//  of `new Date(...)`, so the stored value no longer depends on the server.
//
//  Strings that carry their own offset (`…Z`, `…+02:00`) are respected as
//  written, and date-only strings (`2026-09-19`) are already UTC by spec.
// ─────────────────────────────────────────

const OFFSETLESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export const parseClientDateTime = (value: string): Date =>
  new Date(OFFSETLESS_DATE_TIME.test(value) ? `${value}Z` : value);
