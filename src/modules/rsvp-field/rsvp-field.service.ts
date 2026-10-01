import { type PlatformRole } from '@prisma/client';
import { rsvpFieldRepository } from './rsvp-field.repository.js';
import { type CreateRsvpFieldDto, type UpdateRsvpFieldDto } from './rsvp-field.types.js';
import { requireFieldLabel, requireFieldType } from './rsvp-field-validation.util.js';
import { eventService } from '../event/event.service.js';
import { assertEventUpdatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { HttpError } from '../../shared/errors/http-error.js';

// RsvpField has no tenantId of its own — ownership is transitive through
// its event, like every other event sub-resource. Every method gates
// through eventService (404 for another tenant's event, SUPER_ADMIN
// unscoped) AND checks the field belongs to the :eventId in the URL. These
// endpoints used to do neither: any EVENT_ADMIN could read, create, edit
// or archive any event's custom questions by id.
const fieldInScope = async (id: string, eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
  await eventService.getScoped(eventId, requestingRole, tenantId);
  const field = await rsvpFieldRepository.findById(id);
  if (!field || field.eventId !== eventId) throw new HttpError(404, 'RSVP field not found');
  return field;
};

export const rsvpFieldService = {

  getAll: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await eventService.getScoped(eventId, requestingRole, tenantId);
    return rsvpFieldRepository.findAll(eventId);
  },

  getById: (id: string, eventId: string, requestingRole: PlatformRole, tenantId: string | null) =>
    fieldInScope(id, eventId, requestingRole, tenantId),

  // Adding a custom question is the tier-gated capability (SPARK has none —
  // event-tier-enforcement.util.ts). It was enforced only in the wizard's
  // materialize, so a SPARK organiser could add questions here directly.
  // Event-scoped, like every check on an existing event: the tenant's
  // effective tier OR an Event Pass on this event unlocks it. Editing or
  // archiving a question that already exists adds no capability, so those
  // are not gated — a tenant that lapses keeps managing what it has.
  create: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateRsvpFieldDto) => {
    const event = await eventService.getScopedWithPass(eventId, requestingRole, tenantId);
    const label = requireFieldLabel(data.label);
    const fieldType = requireFieldType(data.fieldType, label);
    await assertEventUpdatable(event, { hasCustomRsvpFields: true });
    return rsvpFieldRepository.create(eventId, userId, { ...data, label, fieldType });
  },

  update: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateRsvpFieldDto) => {
    const field = await fieldInScope(id, eventId, requestingRole, tenantId);
    const label = data.label !== undefined ? requireFieldLabel(data.label) : undefined;
    const fieldType = data.fieldType !== undefined ? requireFieldType(data.fieldType, label ?? field.label) : undefined;
    return rsvpFieldRepository.update(id, userId, {
      ...data,
      ...(label !== undefined && { label }),
      ...(fieldType !== undefined && { fieldType }),
    });
  },

  archive: async (id: string, eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await fieldInScope(id, eventId, requestingRole, tenantId);
    return rsvpFieldRepository.archive(id, userId);
  },
};
