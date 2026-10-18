import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { parseClientDateTime, isSameUtcDate } from '../../shared/utils/date-input.util.js';
import {
  eventService,
  assertEventFieldsValid,
  assertEventUpdateAllowed,
  destroyReplacedCover,
} from '../event/event.service.js';
import { normalizeHostName } from '../event/event.repository.js';
import { type UpdateEventDto } from '../event/event.types.js';
import { type EventDayWrite, type EventDayPatch } from '../event-day/event-day.repository.js';
import {
  resolveNewDay,
  resolveDayChanges,
  findDuplicateDayLabel,
  duplicateDayLabelMessage,
} from '../event-day/event-day-validation.util.js';
import { resolveNewTicket, resolveTicketChanges } from '../ticket/ticket-validation.util.js';
import { TICKETING_UNAVAILABLE_MESSAGE } from '../ticket/ticketing-availability.util.js';
import { resolveNewField, resolveFieldChanges } from '../rsvp-field/rsvp-field-validation.util.js';
import {
  requireItemTitle,
  requireItemStartTime,
  optionalItemDuration,
  assertItemHasDay,
  resolveItemDayIndex,
  assertItemStartsOnItsDay,
  assertProgramVisibilityFlag,
} from '../program-item/program-item-validation.util.js';
import { assertEventUpdatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { assertValidOpensAt } from '../memory-hub/memory-hub-validation.util.js';
import { eventFullUpdateRepository, type FullUpdatePlan, type DayRef, type PlannedItem } from './event-full-update.repository.js';
import {
  type FullEventUpdateDto,
  type FullUpdateDay,
  type FullUpdateTicket,
  type FullUpdateRsvpField,
  type FullUpdateProgramItem,
} from './event-full-update.types.js';

// ─────────────────────────────────────────
//  THE FULL EVENT UPDATE — all or nothing
//
//  The wizard's edit mode used to save each step as the organiser tapped
//  Next, so guests saw a new date before "Save changes" and leaving midway
//  kept half the edit. This applies the whole edited event at once:
//
//  1. Scope: eventService.getById, so tenant scoping and the assignment
//     lock are exactly every other event lookup's (another tenant's or an
//     unassigned event is a 404).
//  2. Plan: every part is checked by the SAME helpers its own endpoint
//     calls (event-day-validation.util.ts, ticket-validation.util.ts,
//     rsvp-field-validation.util.ts, program-item-validation.util.ts, and
//     event.service.ts's assertEventFieldsValid/assertEventUpdateAllowed),
//     so every refusal is that endpoint's refusal, same status, words and
//     code. A child id that isn't this event's live child is that
//     endpoint's 404. Nothing has been written yet.
//  3. Write: only what changed, in one transaction under the event's row
//     lock (eventRepository.withEventWriteLock). Any failure there rolls
//     everything back.
//
//  Cancelled and completed events follow today's rules, which is to say
//  none: no per-part edit endpoint refuses them, so neither does this.
//  Removing a day archives it, as DELETE .../days/:id does, with the same
//  (lack of) refusals.
// ─────────────────────────────────────────

// ── Request shape (400 for a malformed body, as a wrong type is elsewhere) ──

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalObject = (value: unknown, what: string): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new HttpError(400, `${what} must be an object.`);
  return value;
};

const optionalList = <T>(value: unknown, what: string): T[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isPlainObject)) throw new HttpError(400, `${what} must be a list of objects.`);
  return value as T[];
};

// The saved row each `id` names, once each. An unknown id is the 404 the
// row's own endpoint gives for an id that isn't this event's.
const matchSavedRows = <Row extends { id?: string }, Saved extends { id: string }>(
  rows: Row[],
  saved: Saved[],
  what: string,
  notFound: string
): { row: Row; stored: Saved | null }[] => {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.id === undefined || row.id === null) return { row, stored: null };
    if (typeof row.id !== 'string') throw new HttpError(400, `Each ${what}'s id must be a string.`);
    if (seen.has(row.id)) throw new HttpError(400, `The same ${what} appears twice in this request.`);
    seen.add(row.id);
    const stored = saved.find((s) => s.id === row.id);
    if (!stored) throw new HttpError(404, notFound);
    return { row, stored };
  });
};

const removedRows = <Saved extends { id: string }>(saved: Saved[], rows: { id?: string }[]): string[] => {
  const kept = new Set(rows.map((r) => r.id).filter((id): id is string => typeof id === 'string'));
  return saved.filter((s) => !kept.has(s.id)).map((s) => s.id);
};

const sameInstant = (a: Date | null, b: Date | null): boolean => (a?.getTime() ?? null) === (b?.getTime() ?? null);
const plainNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

type LoadedEvent = Awaited<ReturnType<typeof eventService.getById>>;

// ── The event row ──

const eventFieldsChanged = (event: LoadedEvent, d: UpdateEventDto): boolean =>
  (d.name !== undefined && d.name !== event.name) ||
  (d.description !== undefined && (d.description ?? null) !== event.description) ||
  (d.coverImageUrl !== undefined && (d.coverImageUrl ?? null) !== event.coverImageUrl) ||
  (d.coverImagePublicId !== undefined && (d.coverImagePublicId ?? null) !== event.coverImagePublicId) ||
  (d.visibility !== undefined && d.visibility !== event.visibility) ||
  (d.ticketing !== undefined && d.ticketing !== event.ticketing) ||
  (d.hostName !== undefined && normalizeHostName(d.hostName) !== event.hostName) ||
  (d.rsvpDeadline !== undefined && !sameInstant(d.rsvpDeadline ? parseClientDateTime(d.rsvpDeadline) : null, event.rsvpDeadline)) ||
  (d.capacity !== undefined && (d.capacity ?? null) !== event.capacity) ||
  (d.ticketsRefundable !== undefined && d.ticketsRefundable !== event.ticketsRefundable);

// ── Days ──

// A day as it will be after this save, for the RSVP deadline, the item
// rules and the label check.
interface ResultingDay {
  ref: DayRef;
  id: string | null;
  label: string;
  date: Date;
  endTime: Date | null;
  dateChanged: boolean;
}

const planDays = (event: LoadedEvent, input: FullUpdateDay[] | undefined) => {
  if (input === undefined) {
    const resulting: ResultingDay[] = event.eventDays.map((d) => ({
      ref: { kind: 'saved', id: d.id },
      id: d.id,
      label: d.label,
      date: d.date,
      endTime: d.endTime,
      dateChanged: false,
    }));
    return { resulting, creates: [] as EventDayWrite[], updates: [] as { id: string; patch: EventDayPatch; relabel: boolean }[], archives: [] as string[] };
  }

  const creates: EventDayWrite[] = [];
  const updates: { id: string; patch: EventDayPatch; relabel: boolean }[] = [];
  const resulting: ResultingDay[] = [];

  for (const { row, stored } of matchSavedRows(input, event.eventDays, 'day', 'Event day not found')) {
    if (!stored) {
      const day = resolveNewDay(row);
      resulting.push({ ref: { kind: 'new', index: creates.length }, id: null, label: day.label, date: day.date, endTime: day.endTime, dateChanged: true });
      creates.push(day);
      continue;
    }
    const patch = resolveDayChanges(row, stored);
    const label = patch.label ?? stored.label;
    const date = patch.date ?? stored.date;
    const startTime = patch.startTime !== undefined ? patch.startTime : stored.startTime;
    const endTime = patch.endTime !== undefined ? patch.endTime : stored.endTime;
    const changed =
      label !== stored.label ||
      !isSameUtcDate(date, stored.date) ||
      !sameInstant(startTime, stored.startTime) ||
      !sameInstant(endTime, stored.endTime) ||
      patch.venue.location !== stored.location ||
      patch.venue.address !== stored.address ||
      patch.venue.latitude !== plainNumber(stored.latitude) ||
      patch.venue.longitude !== plainNumber(stored.longitude);
    if (changed) updates.push({ id: stored.id, patch, relabel: label !== stored.label });
    resulting.push({ ref: { kind: 'saved', id: stored.id }, id: stored.id, label, date, endTime, dateChanged: !isSameUtcDate(date, stored.date) });
  }

  // Unique per event, ignoring case — the same rule (and words) as
  // POST/PUT .../days, judged on the days this save leaves.
  const duplicate = findDuplicateDayLabel(resulting.map((d) => d.label));
  if (duplicate !== null) throw new HttpError(409, duplicateDayLabelMessage(duplicate));

  return { resulting, creates, updates, archives: removedRows(event.eventDays, input) };
};

// ── Tickets ──

const planTickets = (event: LoadedEvent, input: FullUpdateTicket[] | undefined) => {
  const plan = { creates: [] as FullUpdatePlan['tickets']['creates'], updates: [] as FullUpdatePlan['tickets']['updates'], archives: [] as string[] };
  if (input === undefined) return plan;

  for (const { row, stored } of matchSavedRows(input, event.tickets, 'ticket type', 'Ticket not found')) {
    if (!stored) {
      plan.creates.push({
        ...resolveNewTicket(row),
        ...(row.description !== undefined && row.description !== null && { description: row.description }),
        ...(row.currency !== undefined && { currency: row.currency }),
      });
      continue;
    }
    const { id: _id, ...fields } = row;
    const data = { ...fields, ...resolveTicketChanges(row, stored) };
    const changed =
      (data.name !== undefined && data.name !== stored.name) ||
      (data.description !== undefined && (data.description ?? null) !== stored.description) ||
      (data.price !== undefined && data.price !== Number(stored.price)) ||
      (data.currency !== undefined && data.currency !== stored.currency) ||
      (data.totalQuantity !== undefined && (data.totalQuantity ?? null) !== stored.totalQuantity) ||
      (data.isAvailable !== undefined && data.isAvailable !== stored.isAvailable);
    if (changed) plan.updates.push({ id: stored.id, data });
  }
  plan.archives = removedRows(event.tickets, input);
  return plan;
};

// ── Custom RSVP questions ──

const planRsvpFields = (event: LoadedEvent, input: FullUpdateRsvpField[] | undefined) => {
  const plan = { creates: [] as FullUpdatePlan['rsvpFields']['creates'], updates: [] as FullUpdatePlan['rsvpFields']['updates'], archives: [] as string[] };
  if (input === undefined) return plan;

  matchSavedRows(input, event.rsvpFields, 'custom RSVP question', 'RSVP field not found').forEach(({ row, stored }, order) => {
    if (!stored) {
      plan.creates.push({
        ...resolveNewField(row),
        isRequired: row.isRequired ?? false,
        ...(row.options !== undefined && row.options !== null && { options: row.options }),
        order,
      });
      return;
    }
    const { id: _id, ...fields } = row;
    const data = { ...fields, ...resolveFieldChanges(row, stored), order };
    const changed =
      (data.label !== undefined && data.label !== stored.label) ||
      (data.fieldType !== undefined && data.fieldType !== stored.fieldType) ||
      (data.isRequired !== undefined && data.isRequired !== stored.isRequired) ||
      (data.options !== undefined && (data.options ?? null) !== stored.options) ||
      order !== stored.order;
    if (changed) plan.updates.push({ id: stored.id, data });
  });
  plan.archives = removedRows(event.rsvpFields, input);
  return plan;
};

// ── Program and its items ──

const planProgram = (event: LoadedEvent, input: Record<string, unknown> | undefined, days: ResultingDay[]): FullUpdatePlan['program'] => {
  if (input === undefined) return null;
  assertProgramVisibilityFlag(input.isPublished);
  if (input.title !== undefined && input.title !== null && typeof input.title !== 'string') {
    throw new HttpError(400, "The program's title must be text.");
  }
  const programTitle = input.title as string | null | undefined;
  const isPublished = input.isPublished as boolean | undefined;
  const items = optionalList<FullUpdateProgramItem>(input.items, 'program.items');

  // An archived program still holds the event's one program row
  // (EventProgram.eventId is unique), and nothing restores one.
  const stored = event.program && !event.program.isArchived ? event.program : null;
  if (event.program?.isArchived && items?.length) {
    throw new HttpError(409, "This event's program was archived, so items can't be added to it.");
  }

  const savedItems = stored?.programItems ?? [];
  const planned = { creates: [] as PlannedItem[], updates: [] as (PlannedItem & { id: string })[], archives: [] as string[] };

  (items ? matchSavedRows(items, savedItems, 'program item', 'Program item not found') : []).forEach(({ row, stored: saved }, order) => {
    // The same helpers as POST/PUT .../items; on a saved item, a field left
    // out keeps its stored value, as PUT does.
    const title = saved && row.title === undefined ? saved.title : requireItemTitle(row.title);
    const startTime = saved && row.startTime === undefined ? saved.startTime : requireItemStartTime(row.startTime, title);
    const durationMins = saved && row.durationMins === undefined ? saved.durationMins : optionalItemDuration(row.durationMins, title);
    const description = saved && row.description === undefined ? saved.description : row.description ?? null;

    // Its day: by position in this save's days. Left out on a saved item,
    // its stored day is kept, as PUT .../items/:id keeps it (and, as there,
    // isn't then required on a multi-day event).
    let day: DayRef | null;
    let resultingDay: ResultingDay | null;
    if (row.dayIndex !== undefined || !saved) {
      const index = resolveItemDayIndex(row.dayIndex, days.length, title);
      assertItemHasDay(index !== null, days.length, title);
      resultingDay = index === null ? null : days[index]!;
      day = resultingDay ? resultingDay.ref : null;
    } else {
      // A stored day this save archives is no longer live, so there is
      // nothing left to match it against.
      resultingDay = saved.eventDayId ? days.find((d) => d.id === saved.eventDayId) ?? null : null;
      day = saved.eventDayId ? { kind: 'saved', id: saved.eventDayId } : null;
    }

    const dayChanged = !saved || day?.kind === 'new' || (day?.kind === 'saved' ? day.id : null) !== saved.eventDayId;
    const startChanged = !saved || startTime.getTime() !== saved.startTime.getTime();
    if (dayChanged || startChanged || resultingDay?.dateChanged) {
      assertItemStartsOnItsDay(startTime, resultingDay, title);
    }

    const values: PlannedItem = { title, description, startTime, durationMins, order, day };
    if (!saved) {
      planned.creates.push(values);
    } else if (
      dayChanged || startChanged ||
      title !== saved.title || description !== saved.description ||
      durationMins !== saved.durationMins || order !== saved.order
    ) {
      planned.updates.push({ id: saved.id, ...values });
    }
  });
  if (items) planned.archives = removedRows(savedItems, items);

  // A program is created once it has items, as the wizard always did.
  const needsProgram = !stored && planned.creates.length > 0;
  const programChanged =
    !!stored &&
    ((programTitle !== undefined && (programTitle ?? null) !== stored.title) ||
      (isPublished !== undefined && isPublished !== stored.isPublished));

  return {
    programId: stored?.id ?? null,
    create: needsProgram ? { title: programTitle ?? null, isPublished: isPublished !== false } : null,
    update: programChanged
      ? { ...(programTitle !== undefined && { title: programTitle }), ...(isPublished !== undefined && { isPublished }) }
      : null,
    items: planned,
  };
};

// ── Memory Hub opening time ──

const planMemoryHub = (event: LoadedEvent, input: Record<string, unknown> | undefined): FullUpdatePlan['memoryHub'] => {
  if (input === undefined || input.opensAt === undefined) return null;
  assertValidOpensAt(input.opensAt);
  const opensAt = input.opensAt as string | null;
  const hub = event.memoryHub;
  // PUT .../memory-hub/:id's own lookup refuses an archived hub.
  if (hub?.isArchived) throw new HttpError(404, 'Memory hub not found');
  if (hub && sameInstant(opensAt ? parseClientDateTime(opensAt) : null, hub.opensAt)) return null;
  return { hubId: hub?.id ?? null, opensAt };
};

const hasChanges = (plan: FullUpdatePlan): boolean =>
  plan.event !== null ||
  plan.days.creates.length + plan.days.updates.length + plan.days.archives.length > 0 ||
  plan.tickets.creates.length + plan.tickets.updates.length + plan.tickets.archives.length > 0 ||
  plan.rsvpFields.creates.length + plan.rsvpFields.updates.length + plan.rsvpFields.archives.length > 0 ||
  (plan.program !== null &&
    (plan.program.create !== null ||
      plan.program.update !== null ||
      plan.program.items.creates.length + plan.program.items.updates.length + plan.program.items.archives.length > 0)) ||
  plan.memoryHub !== null;

export const eventFullUpdateService = {

  update: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: unknown) => {
    if (!isPlainObject(body)) throw new HttpError(400, 'The request body must be an object.');
    const dto = body as FullEventUpdateDto;
    const eventFields = optionalObject(dto.event, 'event') as UpdateEventDto | undefined;
    const daysInput = optionalList<FullUpdateDay>(dto.days, 'days');
    const ticketsInput = optionalList<FullUpdateTicket>(dto.tickets, 'tickets');
    const fieldsInput = optionalList<FullUpdateRsvpField>(dto.rsvpFields, 'rsvpFields');
    const programInput = optionalObject(dto.program, 'program');
    const hubInput = optionalObject(dto.memoryHub, 'memoryHub');

    // Scope first: another tenant's event, or one a locked member isn't
    // assigned to, is a 404 before anything about the body is judged.
    const event = await eventService.getById(eventId, requestingRole, tenantId);

    // The event's own fields, then each part, in the wizard's order.
    if (eventFields) assertEventFieldsValid(eventFields);
    const days = planDays(event, daysInput);
    if (eventFields) await assertEventUpdateAllowed(event, eventFields, days.resulting);

    const tickets = planTickets(event, ticketsInput);
    // The ticket routes are switched off with `ticketing`; a change to
    // tickets is refused here as a change to paid ticketing is (422,
    // before any tier check). Re-sending them unchanged is fine.
    if (tickets.creates.length + tickets.updates.length + tickets.archives.length > 0 && !isFeatureEnabled('ticketing')) {
      throw new HttpError(422, TICKETING_UNAVAILABLE_MESSAGE);
    }

    const rsvpFields = planRsvpFields(event, fieldsInput);
    // Adding a question is the tier-gated capability, as on POST
    // .../rsvp-fields; editing or archiving one is not.
    if (rsvpFields.creates.length > 0) await assertEventUpdatable(event, { hasCustomRsvpFields: true });

    const program = planProgram(event, programInput, days.resulting);
    const memoryHub = planMemoryHub(event, hubInput);

    const plan: FullUpdatePlan = {
      event: eventFields && eventFieldsChanged(event, eventFields) ? eventFields : null,
      days: { creates: days.creates, updates: days.updates, archives: days.archives },
      tickets,
      rsvpFields,
      program,
      memoryHub,
    };

    if (hasChanges(plan)) {
      await eventFullUpdateRepository.apply(eventId, userId, plan);
      if (plan.event) destroyReplacedCover(event, plan.event);
    }

    // The same shape as GET /api/events/:id, so the wizard can re-baseline
    // from the response.
    return eventService.getDetail(eventId, requestingRole, tenantId);
  },
};
