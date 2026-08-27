import { eventDayRepository } from './event-day.repository.js';
import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';
import { eventService } from '../event/event.service.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertNoDuplicateDayLabel, isDayLabelUniqueViolation } from './event-day-validation.util.js';

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

  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const day = await eventDayRepository.findById(id);
    if (!day) throw new HttpError(404, 'Event day not found');
    // Ownership gate via the parent event — throws 404 if it belongs to
    // a different tenant, indistinguishable from the day not existing.
    await eventService.getById(day.eventId, requestingRole, tenantId);
    return day;
  },

  create: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateEventDayDto) => {
    await eventService.getById(eventId, requestingRole, tenantId);
    await assertNoDuplicateDayLabel(eventId, data.label);
    try {
      return await eventDayRepository.create(eventId, userId, data);
    } catch (err) {
      if (isDayLabelUniqueViolation(err)) {
        throw new HttpError(409, `This event already has a day labeled '${data.label}' — day labels must be unique per event`);
      }
      throw err;
    }
  },

  update: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDayDto) => {
    const day = await eventDayService.getById(id, requestingRole, tenantId);
    if (data.label !== undefined) {
      await assertNoDuplicateDayLabel(day.eventId, data.label, id);
    }
    try {
      return await eventDayRepository.update(id, userId, data);
    } catch (err) {
      if (isDayLabelUniqueViolation(err)) {
        throw new HttpError(409, `This event already has a day labeled '${data.label ?? day.label}' — day labels must be unique per event`);
      }
      throw err;
    }
  },

  archive: async (id: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventDayService.getById(id, requestingRole, tenantId);
    return eventDayRepository.archive(id, userId);
  },
};