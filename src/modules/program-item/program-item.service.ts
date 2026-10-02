import { type PlatformRole } from '@prisma/client';
import { programItemRepository } from './program-item.repository.js';
import { type CreateProgramItemDto, type UpdateProgramItemDto } from './program-item.types.js';
import { eventProgramRepository } from '../event-program/event-program.repository.js';
import { eventDayRepository } from '../event-day/event-day.repository.js';
import { eventService } from '../event/event.service.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { requireItemTitle, requireItemStartTime, assertValidItemOrder } from './program-item-validation.util.js';

// ProgramItem has no tenantId of its own — ownership is transitive
// through programId -> EventProgram.eventId -> Event.tenantId, two hops.
// Unlike event-day (one hop), the route also carries a :programId
// alongside :eventId, and a program id alone does not prove which
// event's program it names — the previous version of this file ignored
// :eventId entirely, so any EVENT_ADMIN could read/write ANY event's
// program items by guessing/enumerating a programId. Every method here
// therefore both tenant-scopes through eventService.getById() AND
// checks the loaded program's own eventId against the URL's :eventId —
// a mismatch (wrong tenant OR right tenant, wrong event) is the same
// 404 as a genuinely missing program, per STEERING's cross-tenant rule.
const assertProgramInScope = async (
  eventId: string,
  programId: string,
  requestingRole: PlatformRole,
  tenantId: string | null
) => {
  await eventService.getById(eventId, requestingRole, tenantId); // throws 404 if wrong tenant
  const program = await eventProgramRepository.findById(programId);
  if (!program || program.eventId !== eventId) {
    throw new HttpError(404, 'Program not found for this event');
  }
  return program;
};

// eventDayId must belong to the SAME event as the program — checked via
// the (already tenant-scoped-through-eventService, unscoped-by-design —
// see event-day.repository.ts) transitive lookup, same reuse pattern as
// eventDayService.getById itself.
const assertEventDayInScope = async (eventId: string, eventDayId: string): Promise<void> => {
  const day = await eventDayRepository.findById(eventDayId);
  if (!day || day.eventId !== eventId) {
    throw new HttpError(422, "That day doesn't belong to this event.");
  }
};

export const programItemService = {

  getAll: async (eventId: string, programId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await assertProgramInScope(eventId, programId, requestingRole, tenantId);
    return programItemRepository.findAll(programId);
  },

  getById: async (
    id: string,
    eventId: string,
    programId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ) => {
    await assertProgramInScope(eventId, programId, requestingRole, tenantId);
    const item = await programItemRepository.findById(id);
    // Same reasoning as assertProgramInScope: an item id that exists but
    // belongs to a DIFFERENT program (even one on the same event) is not
    // this item under this URL — 404, not a leak of its real location.
    if (!item || item.programId !== programId) {
      throw new HttpError(404, 'Program item not found');
    }
    return item;
  },

  create: async (
    eventId: string,
    programId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: CreateProgramItemDto
  ) => {
    await assertProgramInScope(eventId, programId, requestingRole, tenantId);
    const title = requireItemTitle(data.title);
    requireItemStartTime(data.startTime, title);
    assertValidItemOrder(data.order);
    if (data.eventDayId) {
      await assertEventDayInScope(eventId, data.eventDayId);
    }
    const order = data.order ?? (await programItemRepository.nextOrder(programId));
    return programItemRepository.create(programId, userId, { ...data, title, order });
  },

  update: async (
    id: string,
    eventId: string,
    programId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: UpdateProgramItemDto
  ) => {
    const item = await programItemService.getById(id, eventId, programId, requestingRole, tenantId);
    const title = data.title !== undefined ? requireItemTitle(data.title) : undefined;
    if (data.startTime !== undefined) requireItemStartTime(data.startTime, title ?? item.title);
    assertValidItemOrder(data.order);
    if (data.eventDayId !== undefined && data.eventDayId !== null) {
      await assertEventDayInScope(eventId, data.eventDayId);
    }
    return programItemRepository.update(id, userId, { ...data, ...(title !== undefined && { title }) });
  },

  archive: async (
    id: string,
    eventId: string,
    programId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ) => {
    await programItemService.getById(id, eventId, programId, requestingRole, tenantId);
    return programItemRepository.archive(id, userId);
  },
};
