import { eventDayRepository } from './event-day.repository.js';
import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';
import { eventService } from '../event/event.service.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import prisma from '../../shared/prisma/prisma.client.js';
import { assertDaysRemovable, forgetRemovedDays } from '../ticket/ticket-day-guard.util.js';
import {
  assertNoDuplicateDayLabel,
  isDayLabelUniqueViolation,
  duplicateDayLabelMessage,
  resolveNewDay,
  resolveDayChanges,
} from './event-day-validation.util.js';
import { capacityWarningsFor } from './day-capacity.util.js';

// EventDay has no tenantId of its own — ownership is transitive through
// its parent Event. Rather than duplicating tenant-scoping logic here,
// every method gates through eventService.getById(), which is already
// fixed and tested for exactly this: it throws HttpError(404) if the
// event doesn't belong to the caller's tenant (SUPER_ADMIN bypasses).
export const eventDayService = {
  getAll: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getById(eventId, requestingRole, tenantId);
    return eventDayRepository.findAll(eventId);
  },

  // The day must belong to the :eventId in the URL, not merely to some
  // event the caller owns — a day reached under another event's URL (even
  // the same tenant's) is the same 404 as one that doesn't exist, exactly
  // like program-item.service.ts's assertProgramInScope. The tenant gate
  // runs on the URL's event first, so another tenant's day can never
  // be distinguished from a missing one.
  getById: async (id: string, eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getById(eventId, requestingRole, tenantId);
    const day = await eventDayRepository.findById(id);
    if (!day || day.eventId !== eventId) throw new HttpError(404, 'Event day not found');
    return day;
  },

  create: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateEventDayDto) => {
    await eventService.getById(eventId, requestingRole, tenantId);
    const day = resolveNewDay(data);
    await assertNoDuplicateDayLabel(eventId, day.label);
    try {
      return await eventDayRepository.create(eventId, userId, day);
    } catch (err) {
      if (isDayLabelUniqueViolation(err)) {
        throw new HttpError(409, duplicateDayLabelMessage(day.label));
      }
      throw err;
    }
  },

  update: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDayDto) => {
    const day = await eventDayService.getById(id, eventId, requestingRole, tenantId);
    const patch = resolveDayChanges(data, day);
    if (patch.label !== undefined) {
      await assertNoDuplicateDayLabel(day.eventId, patch.label, id);
    }
    try {
      const updated = await eventDayRepository.update(id, userId, patch);
      // A capacity changed to below the number already attending is saved
      // and warned about, to the organiser only (day-capacity.util.ts).
      const capacityWarnings = patch.venue.capacity !== day.capacity ? await capacityWarningsFor([id]) : [];
      return { ...updated, capacityWarnings };
    } catch (err) {
      if (isDayLabelUniqueViolation(err)) {
        throw new HttpError(409, duplicateDayLabelMessage(patch.label ?? day.label));
      }
      throw err;
    }
  },

  // Refused while a ticket type with sales admits the day, or when it is
  // the only day a type admits (ticket-day-guard.util.ts).
  archive: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const day = await eventDayService.getById(id, eventId, requestingRole, tenantId);
    await assertDaysRemovable(eventId, [{ id: day.id, label: day.label }]);
    return prisma.$transaction(async (tx) => {
      await forgetRemovedDays([id], tx);
      return eventDayRepository.archive(id, userId, tx);
    });
  },
};