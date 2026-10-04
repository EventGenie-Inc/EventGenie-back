import { eventDayRepository } from './event-day.repository.js';
import { type CreateEventDayDto, type UpdateEventDayDto } from './event-day.types.js';
import { eventService } from '../event/event.service.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { assertNoDuplicateDayLabel, isDayLabelUniqueViolation, requireDayLabel, requireDayDate, assertDayTimesInOrder } from './event-day-validation.util.js';
import { resolveDayVenueForCreate, resolveDayVenueForUpdate } from './event-day-venue.util.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';

// startTime/endTime are optional; an explicit null (or blank) clears one.
// Never new Date(null) — that is 1970-01-01, the bug the old repository
// comment described.
const optionalDateTime = (value: string | null | undefined): Date | null =>
  value ? parseClientDateTime(value) : null;

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
    const label = requireDayLabel(data.label);
    const date = requireDayDate(data.date, label);
    const venue = resolveDayVenueForCreate(data, label);
    const startTime = optionalDateTime(data.startTime);
    const endTime = optionalDateTime(data.endTime);
    assertDayTimesInOrder(startTime, endTime, label);
    await assertNoDuplicateDayLabel(eventId, label);
    try {
      return await eventDayRepository.create(eventId, userId, {
        label,
        date,
        startTime,
        endTime,
        venue,
      });
    } catch (err) {
      if (isDayLabelUniqueViolation(err)) {
        throw new HttpError(409, `This event already has a day labeled '${label}' — day labels must be unique per event`);
      }
      throw err;
    }
  },

  update: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateEventDayDto) => {
    const day = await eventDayService.getById(id, eventId, requestingRole, tenantId);
    const label = data.label !== undefined ? requireDayLabel(data.label) : undefined;
    const effectiveLabel = label ?? day.label;
    const date = data.date !== undefined ? requireDayDate(data.date, effectiveLabel) : undefined;
    const venue = resolveDayVenueForUpdate(data, day, effectiveLabel);
    const startTime = data.startTime !== undefined ? optionalDateTime(data.startTime) : undefined;
    const endTime = data.endTime !== undefined ? optionalDateTime(data.endTime) : undefined;
    assertDayTimesInOrder(startTime !== undefined ? startTime : day.startTime, endTime !== undefined ? endTime : day.endTime, effectiveLabel);
    if (label !== undefined) {
      await assertNoDuplicateDayLabel(day.eventId, label, id);
    }
    try {
      return await eventDayRepository.update(id, userId, {
        ...(label !== undefined && { label }),
        ...(date !== undefined && { date }),
        ...(startTime !== undefined && { startTime }),
        ...(endTime !== undefined && { endTime }),
        venue,
      });
    } catch (err) {
      if (isDayLabelUniqueViolation(err)) {
        throw new HttpError(409, `This event already has a day labeled '${effectiveLabel}' — day labels must be unique per event`);
      }
      throw err;
    }
  },

  archive: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventDayService.getById(id, eventId, requestingRole, tenantId);
    return eventDayRepository.archive(id, userId);
  },
};