import prisma from '../../shared/prisma/prisma.client.js';
import { eventDraftRepository } from './event-draft.repository.js';
import { eventRepository } from '../event/event.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { type UpsertEventDraftDto } from './event-draft.types.js';
import { type EventVisibility, type EventTicketing, type RsvpFieldType } from '@prisma/client';
import { assertEventCreatable } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { requireDayLabel, requireDayDate } from '../event-day/event-day-validation.util.js';
import { resolveDayVenueForCreate } from '../event-day/event-day-venue.util.js';
import { requireTicketName, requireTicketPrice } from '../ticket/ticket-validation.util.js';
import { requireFieldLabel, requireFieldType } from '../rsvp-field/rsvp-field-validation.util.js';
import { requireItemTitle, requireItemStartTime } from '../program-item/program-item-validation.util.js';
import { assertValidRsvpDeadline } from '../event/event-rsvp-deadline.util.js';
import { assertValidCapacity } from '../event/event-capacity.util.js';
import { isCoverImageTooLarge, coverImageTooLargeMessage, assertCoverPublicIdOwned } from '../event/event-cover-image.util.js';
import { destroyAsset } from '../../shared/cloudinary/cloudinary.client.js';
import { parseClientDateTime } from '../../shared/utils/date-input.util.js';

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

    // 422, the same status and words the direct endpoints use — each
    // required field is checked by the SAME helper the matching endpoint
    // calls (event name here; days, tickets, custom fields and program
    // items below), so the wizard can't save what an edit would refuse.
    // No event-level venue any more: it belongs to each day.
    if (typeof p.name !== 'string' || !p.name.trim()) {
      throw new HttpError(422, 'Your event needs a name.');
    }
    const eventName = p.name.trim();
    if (!Array.isArray(p.days) || p.days.length === 0) {
      throw new HttpError(422, 'Your event needs at least one day.');
    }

    const days = (p.days as Array<Record<string, unknown>>).map((day) => {
      const label = requireDayLabel(day.label);
      return {
        label,
        date: requireDayDate(day.date, label),
        startTime: day.startTime ? parseClientDateTime(day.startTime as string) : null,
        endTime: day.endTime ? parseClientDateTime(day.endTime as string) : null,
        venue: resolveDayVenueForCreate(day, label),
      };
    });

    // Duplicate day labels within this draft would make the import
    // engine's Day-column matching ambiguous later — checked purely
    // in-memory, before the transaction starts, since the event doesn't
    // exist yet and there's nothing external to race against. Matches
    // event-day-validation.util.ts's case-insensitive rule.
    const seenLabels = new Set<string>();
    for (const day of days) {
      const label = day.label.toLowerCase();
      if (seenLabels.has(label)) {
        throw new HttpError(409, `Duplicate day label '${day.label}' — day labels must be unique within an event`);
      }
      seenLabels.add(label);
    }

    // Same both-or-neither/plausibility treatment extended to the two
    // Batch A fields — the wizard is the primary event-creation path, so
    // leaving these validated only on the direct POST would make the
    // deadline/capacity feature unreachable from real event creation.
    const capacity = p.capacity !== undefined && p.capacity !== null ? Number(p.capacity) : undefined;
    assertValidCapacity(capacity);

    const rsvpDeadline = p.rsvpDeadline !== undefined && p.rsvpDeadline !== null ? parseClientDateTime(p.rsvpDeadline as string) : undefined;
    assertValidRsvpDeadline(rsvpDeadline ?? null, days, { rejectPast: true });

    // Same size-limit + cleanup-of-the-already-uploaded-file treatment as
    // the direct POST path (event.service.ts) — see event-cover-image.util.ts
    // for why this can only be checked here, after Cloudinary has already
    // reported the file's size back to the frontend.
    const coverImagePublicId = typeof p.coverImagePublicId === 'string' ? p.coverImagePublicId : undefined;
    const coverImageBytes = typeof p.coverImageBytes === 'number' ? p.coverImageBytes : undefined;
    // Ownership first: the size rejection below destroys the asset, and the
    // id is stored on the new event (see assertCoverPublicIdOwned).
    assertCoverPublicIdOwned(tenantId, coverImagePublicId);
    if (isCoverImageTooLarge(coverImageBytes)) {
      if (coverImagePublicId) {
        void destroyAsset(coverImagePublicId).then((result) => {
          if (!result.ok) console.error('[cloudinary cleanup] failed to delete oversized upload:', result.reason);
        });
      }
      throw new HttpError(400, coverImageTooLargeMessage(coverImageBytes));
    }

    const tickets = (Array.isArray(p.tickets) ? (p.tickets as Array<Record<string, unknown>>) : []).map((ticket) => {
      const name = requireTicketName(ticket.name);
      return { ...ticket, name, price: requireTicketPrice(ticket.price, name) } as Record<string, unknown> & { name: string; price: number };
    });
    const customFields = (Array.isArray(p.customFields) ? (p.customFields as Array<Record<string, unknown>>) : []).map((field) => {
      const label = requireFieldLabel(field.label);
      return { ...field, label, fieldType: requireFieldType(field.fieldType, label) } as Record<string, unknown> & { label: string; fieldType: RsvpFieldType };
    });
    const program = p.program as Record<string, unknown> | undefined;
    const programItems = (Array.isArray(program?.items) ? (program.items as Array<Record<string, unknown>>) : []).map((item) => {
      const title = requireItemTitle(item.title);
      return { ...item, title, startTime: requireItemStartTime(item.startTime, title) } as Record<string, unknown> & { title: string; startTime: Date };
    });
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
          name: eventName,
          description: (p.description as string) ?? null,
          coverImageUrl: (p.coverImageUrl as string) ?? null,
          coverImagePublicId: coverImagePublicId ?? null,
          status: 'DRAFT',
          visibility: (p.visibility as EventVisibility) ?? 'PRIVATE',
          ticketing: (p.ticketing as EventTicketing) ?? 'FREE',
          // Shown to guests as the host line; an empty one means no host line.
          hostName: typeof p.hostName === 'string' && p.hostName.trim() ? p.hostName.trim() : null,
          rsvpDeadline: rsvpDeadline ?? null,
          capacity: capacity ?? null,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      for (const day of days) {
        await tx.eventDay.create({
          data: {
            eventId: event.id,
            label: day.label,
            date: day.date,
            startTime: day.startTime,
            endTime: day.endTime,
            location: day.venue.location,
            address: day.venue.address,
            latitude: day.venue.latitude,
            longitude: day.venue.longitude,
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
              name: ticket.name,
              description: (ticket.description as string) ?? null,
              price: ticket.price,
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
            label: field.label,
            fieldType: field.fieldType,
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
            // Visible to guests by default, same as event-program.repository.ts.
            isPublished: true,
            isArchived: false,
            createdBy: userId,
            updatedBy: userId,
          },
        });

        for (const [index, item] of programItems.entries()) {
          await tx.programItem.create({
            data: {
              programId: eventProgram.id,
              title: item.title,
              description: (item.description as string) ?? null,
              startTime: item.startTime,
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
          opensAt: memoryHub?.opensAt ? parseClientDateTime(memoryHub.opensAt as string) : null,
          isArchived: false,
          createdBy: userId,
          updatedBy: userId,
        },
      });

      return event;
    }, {
      // Task 0 (Subscription Billing batch) audit: found with neither
      // timeout nor maxWait set. This materializes a whole wizard draft
      // in sequential per-row loops (days, tickets, custom RSVP fields,
      // program items) — unbounded by any of those counts, the same
      // shape of bug bulkCreateWithInvites and rsvp.service.ts's
      // transaction already hit at real row counts. A draft with a
      // multi-day program and a long custom-field list is a realistic
      // way to exceed Prisma's defaults (~2s connection acquisition,
      // ~5s execution) well before touching Neon's own cold-start cost.
      maxWait: 10000,
      timeout: 15000,
    });

    // Only delete the draft after the transaction fully succeeds.
    await eventDraftRepository.delete(draft.id);

    return eventRepository.findById(result.id);
  },
};
