import { eventRepository } from '../event/event.repository.js';
import { type UpdateEventDto } from '../event/event.types.js';
import { eventDayRepository, type EventDayWrite, type EventDayPatch } from '../event-day/event-day.repository.js';
import { isDayLabelUniqueViolation, duplicateDayLabelMessage } from '../event-day/event-day-validation.util.js';
import { ticketRepository } from '../ticket/ticket.repository.js';
import { type CreateTicketDto, type UpdateTicketDto } from '../ticket/ticket.types.js';
import { rsvpFieldRepository } from '../rsvp-field/rsvp-field.repository.js';
import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from '../rsvp-field/rsvp-field.types.js';
import { eventProgramRepository } from '../event-program/event-program.repository.js';
import { type UpdateEventProgramDto } from '../event-program/event-program.types.js';
import { programItemRepository } from '../program-item/program-item.repository.js';
import { memoryHubRepository } from '../memory-hub/memory-hub.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';

// A day an item belongs to: a saved one by id, or one this save creates,
// by its position among the days created.
export type DayRef = { kind: 'saved'; id: string } | { kind: 'new'; index: number };

export interface PlannedItem {
  title: string;
  description: string | null;
  startTime: Date;
  durationMins: number | null;
  order: number;
  day: DayRef | null;
}

// Everything a full event update writes, already validated and reduced to
// what changed (event-full-update.service.ts). Writing it is all this file
// does, through each part's own repository.
export interface FullUpdatePlan {
  event: UpdateEventDto | null;
  days: {
    creates: EventDayWrite[];
    updates: { id: string; patch: EventDayPatch; relabel: boolean }[];
    archives: string[];
  };
  tickets: { creates: CreateTicketDto[]; updates: { id: string; data: UpdateTicketDto }[]; archives: string[] };
  rsvpFields: { creates: CreateRsvpFieldDto[]; updates: { id: string; data: UpdateRsvpFieldDto }[]; archives: string[] };
  program: {
    programId: string | null;
    create: { title: string | null; isPublished: boolean } | null;
    update: UpdateEventProgramDto | null;
    items: { creates: PlannedItem[]; updates: (PlannedItem & { id: string })[]; archives: string[] };
  } | null;
  memoryHub: { hubId: string | null; opensAt: string | null } | null;
}

// Two days swapping labels would trip the unique (eventId, label) index
// half-way through; every relabelled day first takes a placeholder no
// organiser can type (a cuid is unique), then its new label.
const placeholderLabel = (dayId: string): string => `⁣relabel:${dayId}`;

export const eventFullUpdateRepository = {

  apply: (eventId: string, userId: string, plan: FullUpdatePlan): Promise<void> =>
    eventRepository.withEventWriteLock(eventId, async (tx) => {
      if (plan.event) await eventRepository.update(eventId, userId, plan.event, tx);

      // Days. Archived first: an archived day keeps its label, so a new day
      // can't take it (the index counts archived rows too), the same 409 as
      // POST .../days gives after a DELETE.
      const createdDayIds: string[] = [];
      let dayLabel = '';
      try {
        for (const id of plan.days.archives) await eventDayRepository.archive(id, userId, tx);
        for (const { id, patch, relabel } of plan.days.updates) {
          if (relabel) await eventDayRepository.update(id, userId, { label: placeholderLabel(id), venue: patch.venue }, tx);
        }
        for (const { id, patch } of plan.days.updates) {
          dayLabel = patch.label ?? dayLabel;
          await eventDayRepository.update(id, userId, patch, tx);
        }
        for (const day of plan.days.creates) {
          dayLabel = day.label;
          createdDayIds.push((await eventDayRepository.create(eventId, userId, day, tx)).id);
        }
      } catch (err) {
        if (isDayLabelUniqueViolation(err)) throw new HttpError(409, duplicateDayLabelMessage(dayLabel));
        throw err;
      }
      const dayId = (ref: DayRef | null): string | null =>
        ref === null ? null : ref.kind === 'saved' ? ref.id : createdDayIds[ref.index]!;

      for (const id of plan.tickets.archives) await ticketRepository.archive(id, userId, tx);
      for (const { id, data } of plan.tickets.updates) await ticketRepository.update(id, userId, data, tx);
      for (const data of plan.tickets.creates) await ticketRepository.create(eventId, userId, data, tx);

      for (const id of plan.rsvpFields.archives) await rsvpFieldRepository.archive(id, userId, tx);
      for (const { id, data } of plan.rsvpFields.updates) await rsvpFieldRepository.update(id, userId, data, tx);
      for (const data of plan.rsvpFields.creates) await rsvpFieldRepository.create(eventId, userId, data, tx);

      if (plan.program) {
        let programId = plan.program.programId;
        if (plan.program.create) {
          const created = await eventProgramRepository.create(eventId, userId, { ...(plan.program.create.title !== null && { title: plan.program.create.title }) }, tx);
          programId = created.id;
          // Created visible, as POST .../program does; hidden only when asked.
          if (!plan.program.create.isPublished) await eventProgramRepository.update(programId, userId, { isPublished: false }, tx);
        } else if (plan.program.update && programId) {
          await eventProgramRepository.update(programId, userId, plan.program.update, tx);
        }
        if (programId) {
          const items = plan.program.items;
          for (const id of items.archives) await programItemRepository.archive(id, userId, tx);
          for (const item of items.updates) {
            await programItemRepository.update(item.id, userId, {
              title: item.title,
              description: item.description,
              startTime: item.startTime.toISOString(),
              durationMins: item.durationMins,
              order: item.order,
              eventDayId: dayId(item.day),
            }, tx);
          }
          for (const item of items.creates) {
            await programItemRepository.create(programId, userId, {
              title: item.title,
              ...(item.description !== null && { description: item.description }),
              startTime: item.startTime.toISOString(),
              durationMins: item.durationMins,
              order: item.order,
              eventDayId: dayId(item.day),
            }, tx);
          }
        }
      }

      if (plan.memoryHub) {
        if (plan.memoryHub.hubId) {
          await memoryHubRepository.update(plan.memoryHub.hubId, userId, { opensAt: plan.memoryHub.opensAt }, tx);
        } else {
          // Every event has a hub from creation; this repairs one without,
          // as the wizard did through POST .../memory-hub.
          await memoryHubRepository.create(eventId, userId, { ...(plan.memoryHub.opensAt !== null && { opensAt: plan.memoryHub.opensAt }) }, tx);
        }
      }
    }),
};
