import { type PlatformRole } from '@prisma/client';
import { eventProgramRepository } from './event-program.repository.js';
import { type CreateEventProgramDto, type UpdateEventProgramDto } from './event-program.types.js';
import { eventService } from '../event/event.service.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { toDayVenueView } from '../event-day/event-day-venue.util.js';

// Guest-facing date matching — UTC only, per STEERING's "guest-facing
// dates are UTC" anchor (guest-date.util.ts). EventDay.date is a
// @db.Date column (Prisma round-trips it as UTC midnight); ProgramItem.
// startTime is a full DateTime built by parseClientDateTime, which
// treats an offset-less client string as literal UTC. Comparing the
// UTC calendar components of both is therefore the correct "same day"
// test, not a millisecond/instant comparison.
const isSameUtcDate = (a: Date, b: Date): boolean =>
  a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();

export const eventProgramService = {

  // ── Organiser management — tenant-scoped ───────────────────────────
  //
  // EventProgram has no tenantId of its own — ownership is transitive
  // through its parent Event. Every method gates through
  // eventService.getById() first, exactly like event-day/memory-hub
  // gate through it: it throws HttpError(404) if the event belongs to
  // a different tenant (SUPER_ADMIN bypasses), so a cross-tenant
  // program read/write is indistinguishable from a missing one.

  getByEventId: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getById(eventId, requestingRole, tenantId);
    const program = await eventProgramRepository.findByEventId(eventId);
    if (!program) throw new HttpError(404, 'Program not found for this event');
    return program;
  },

  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const program = await eventProgramRepository.findById(id);
    if (!program) throw new HttpError(404, 'Program not found');
    // Ownership gate via the parent event — throws 404 if it belongs to
    // a different tenant, indistinguishable from the program not existing.
    await eventService.getById(program.eventId, requestingRole, tenantId);
    return program;
  },

  create: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateEventProgramDto) => {
    await eventService.getById(eventId, requestingRole, tenantId);
    const existing = await eventProgramRepository.findByEventId(eventId);
    if (existing) throw new HttpError(409, 'A program already exists for this event');
    return eventProgramRepository.create(eventId, userId, data);
  },

  update: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventProgramDto) => {
    await eventProgramService.getById(id, requestingRole, tenantId);
    return eventProgramRepository.update(id, userId, data);
  },

  archive: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventProgramService.getById(id, requestingRole, tenantId);
    return eventProgramRepository.archive(id, userId);
  },

  // ── GUEST program view (Contract A) — authenticated by invite token
  // only, never platform auth. Mirrors memory-hub.service.ts's guest
  // paths: resolve the invite by token, gate on event/program state,
  // and return FLAGS rather than throw on "not available" — the caller
  // is a guest's browser deciding whether to render a Program tab, and
  // STEERING's guest-facing-responses rule means no reason is given for
  // any "not available" branch (cancelled event, no program, unpublished
  // program, or nothing scheduled on this guest's invited days — all
  // read identically from the outside). Invalid/unknown token is the one
  // genuinely error-throwing case, same as rsvp.service.ts's validate().
  getProgramForInvite: async (token: unknown) => {
    if (typeof token !== 'string' || !token) {
      throw new HttpError(400, 'token is required');
    }

    const invite = await inviteRepository.findByToken(token);
    if (!invite) {
      throw new HttpError(404, "This invitation link isn't valid. Check the link in your message, or ask the organiser to resend it.");
    }

    if (resolveEffectiveStatus(invite.event) === 'CANCELLED') {
      return { available: false as const };
    }

    // findByEventId already filters isArchived: false, so an archived
    // program folds into "no program" here — same bucket, same response.
    const program = await eventProgramRepository.findByEventId(invite.eventId);
    if (!program || !program.isPublished) {
      return { available: false as const };
    }

    // days = ONLY this invite's InviteEventDays — never every EventDay
    // on the event, a guest may be invited to a subset (mirrors
    // rsvp.service.ts's validate() projection of invite.inviteEventDay).
    const invitedDays = invite.inviteEventDay
      .map((d) => d.eventDay)
      .slice()
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    // A NULL eventDayId item is matched against the DATE of the item's
    // own startTime, not treated as unconditionally global. This exists
    // because the organiser program UI has no day picker yet (STEERING:
    // KNOWN DEBT) — every organiser-created item today has a null
    // eventDayId, so treating null as "every day" unconditionally would
    // put a single-day item's content on every other day of a
    // multi-day event too. Matched against ALL of the event's days
    // (not just this guest's invited subset) — the item's date either
    // names a real day on the event or it doesn't; only once that's
    // decided does invitation scope apply. Only when the item's date
    // matches NONE of the event's days does it fall back to the old
    // "standing item" behaviour: shown on every one of the GUEST's
    // invited days (a genuinely date-less note, e.g. "bring cash for
    // the bar"). More than one EventDay sharing the same date (unusual,
    // not disallowed by the schema) all count as matches.
    const nullItems = program.programItems
      .filter((item) => item.eventDayId === null)
      .map((item) => {
        const matchedDayIds = invite.event.eventDays.filter((d) => isSameUtcDate(d.date, item.startTime)).map((d) => d.id);
        return { item, matchedDayIds: matchedDayIds.length > 0 ? new Set(matchedDayIds) : null };
      });

    const days = invitedDays.map((day) => {
      const dayScoped = program.programItems.filter((item) => item.eventDayId === day.id);
      const nullMatchedForThisDay = nullItems
        .filter(({ matchedDayIds }) => matchedDayIds === null || matchedDayIds.has(day.id))
        .map(({ item }) => item);

      const items = [...dayScoped, ...nullMatchedForThisDay]
        .slice()
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime() || a.order - b.order)
        .map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          startTime: item.startTime,
          durationMins: item.durationMins,
        }));

      // The day's own venue — a guest reading the day's schedule needs to
      // know where it happens, and days of one event can differ.
      return { eventDayId: day.id, label: day.label, date: day.date, ...toDayVenueView(day), items };
    });

    const totalItems = days.reduce((sum, day) => sum + day.items.length, 0);
    if (totalItems === 0) {
      return { available: false as const };
    }

    return {
      available: true as const,
      title: program.title,
      days,
    };
  },
};
