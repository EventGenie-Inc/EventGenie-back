import prisma from '../../shared/prisma/prisma.client.js';
import { eventDraftRepository } from './event-draft.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { type UpsertEventDraftDto } from './event-draft.types.js';
import { type EventVisibility, type EventTicketing, type RsvpFieldType } from '@prisma/client';
import { assertEventCreatable } from '../subscription-tier-config/event-tier-enforcement.util.js';

export const eventDraftService = {

  getCurrentDraft: (tenantId: string, userId: string) =>
    eventDraftRepository.findByTenantAndUser(tenantId, userId),

  saveDraft: (tenantId: string, userId: string, data: UpsertEventDraftDto) =>
    eventDraftRepository.upsert(tenantId, userId, data),

  discardDraft: async (tenantId: string, userId: string) => {
    const draft = await eventDraftRepository.findByTenantAndUser(tenantId, userId);
    if (!draft) throw new HttpError(404, 'No draft found to discard');
    return eventDraftRepository.delete(draft.id);
  },

  materialize: async (tenantId: string, userId: string) => {
    const draft = await eventDraftRepository.findByTenantAndUser(tenantId, userId);
    if (!draft) throw new HttpError(404, 'No draft found to create event from');

    // Payload shape is owned by the frontend wizard and stored opaquely —
    // only the fields actually needed here are validated/read.
    const p = draft.payload as Record<string, unknown>;

    if (!p.name || !p.location || !Array.isArray(p.days) || p.days.length === 0) {
      throw new HttpError(400, 'Event is missing required fields (name, location, at least one day)');
    }

    const days = p.days as Array<Record<string, unknown>>;
    const tickets = Array.isArray(p.tickets) ? (p.tickets as Array<Record<string, unknown>>) : [];
    const customFields = Array.isArray(p.customFields) ? (p.customFields as Array<Record<string, unknown>>) : [];
    const program = p.program as Record<string, unknown> | undefined;
    const programItems = Array.isArray(program?.items) ? (program.items as Array<Record<string, unknown>>) : [];
    const memoryHub = p.memoryHub as Record<string, unknown> | undefined;

    await assertEventCreatable(tenantId, {
      ...(p.visibility !== undefined && { visibility: p.visibility as EventVisibility }),
      ...(p.ticketing !== undefined && { ticketing: p.ticketing as EventTicketing }),
      hasCustomRsvpFields: customFields.length > 0,
    });

    const result = await prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          tenantId,
          createdByUserId: userId,
          name: p.name as string,
          description: (p.description as string) ?? null,
          location: p.location as string,
          address: (p.address as string) ?? null,
          latitude: (p.latitude as number) ?? null,
          longitude: (p.longitude as number) ?? null,
          coverImageUrl: (p.coverImageUrl as string) ?? null,
          status: 'DRAFT',
          visibility: (p.visibility as EventVisibility) ?? 'PRIVATE',
          ticketing: (p.ticketing as EventTicketing) ?? 'FREE',
          invitationTemplate: (p.invitationTemplate as string) ?? null,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      for (const day of days) {
        await tx.eventDay.create({
          data: {
            eventId: event.id,
            label: day.label as string,
            date: new Date(day.date as string),
            startTime: day.startTime ? new Date(day.startTime as string) : null,
            endTime: day.endTime ? new Date(day.endTime as string) : null,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
          },
        });
      }

      if (p.ticketing === 'PAID') {
        for (const ticket of tickets) {
          await tx.ticket.create({
            data: {
              eventId: event.id,
              name: ticket.name as string,
              description: (ticket.description as string) ?? null,
              price: ticket.price as number,
              currency: (ticket.currency as string) ?? 'ZAR',
              totalQuantity: (ticket.totalQuantity as number) ?? null,
              soldCount: 0,
              isAvailable: true,
              isArchived: false,
              createdBy: userId,
              updatedBy: userId,
            },
          });
        }
      }

      for (const [index, field] of customFields.entries()) {
        await tx.rsvpField.create({
          data: {
            eventId: event.id,
            label: field.label as string,
            fieldType: field.fieldType as RsvpFieldType,
            isRequired: (field.isRequired as boolean) ?? false,
            options: field.options ? JSON.stringify(field.options) : null,
            order: index,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
          },
        });
      }

      if (programItems.length > 0) {
        const eventProgram = await tx.eventProgram.create({
          data: {
            eventId: event.id,
            title: (program?.title as string) ?? null,
            isPublished: false,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
          },
        });

        for (const [index, item] of programItems.entries()) {
          await tx.programItem.create({
            data: {
              programId: eventProgram.id,
              title: item.title as string,
              description: (item.description as string) ?? null,
              startTime: new Date(item.startTime as string),
              durationMins: (item.durationMins as number) ?? null,
              order: index,
              isArchived: false,
              createdBy: userId,
              updatedBy: userId,
            },
          });
        }
      }

      // Every event gets a MemoryHub record on creation; tier-gating on
      // whether it's actually usable happens elsewhere, not at creation time.
      await tx.memoryHub.create({
        data: {
          eventId: event.id,
          title: null,
          description: null,
          isPublic: false,
          opensAt: memoryHub?.opensAt ? new Date(memoryHub.opensAt as string) : null,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      return event;
    });

    // Only delete the draft after the transaction fully succeeds.
    await eventDraftRepository.delete(draft.id);

    return eventRepository.findById(result.id);
  },
};
