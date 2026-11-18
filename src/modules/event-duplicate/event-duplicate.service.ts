import crypto from 'crypto';
import { type PlatformRole, type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService, isCreatorLocked } from '../event/event.service.js';
import { eventRepository } from '../event/event.repository.js';
import { eventAssignmentRepository } from '../event-assignment/event-assignment.repository.js';
import { guestRepository } from '../guest/guest.repository.js';
import { assertEventCreatable, assertWithinEventLimit } from '../subscription-tier-config/event-tier-enforcement.util.js';
import { assertGuestsCreatable } from '../subscription-tier-config/guest-tier-enforcement.util.js';
import { assertPaidTicketingAvailable } from '../ticket/ticketing-availability.util.js';
import { assertPublicEventsAvailable } from '../event/public-events-availability.util.js';
import { assertTenantReadyToSellTickets } from '../payment-account/payment-account-readiness.util.js';
import { requireFieldType } from '../rsvp-field/rsvp-field-validation.util.js';
import { hasDeadlinePassed } from '../event/event-rsvp-deadline.util.js';
import { EVENT_DAY_DATE_IN_PAST, earliestAllowedDayDate } from '../event-day/event-day-validation.util.js';
import { storedFileService, type CopiedFile } from '../storage/stored-file.service.js';
import { storageDeletionWorker } from '../storage/storage-deletion.worker.js';
import { eventDuplicateRepository } from './event-duplicate.repository.js';
import {
  DUPLICATE_ERROR_CODES,
  type ClearedDateField,
  type DuplicateOptions,
  type DuplicationSummary,
} from './event-duplicate.types.js';

// ─────────────────────────────────────────
//  DUPLICATING AN EVENT (STEERING "Duplicating an event")
//
//  A new, unpublished DRAFT in the source's organisation with the source's
//  setup: its details, live days (the first moved to the new date, the rest
//  keeping their spacing; times shifted with them, venues and online links
//  kept), its program, its questions with every setting, its registration
//  settings and Memory Hub settings, with every date shifted by the same
//  whole number of days. Its cover and uploaded invitation design are
//  copied into new files in the copy's own folder, each with its own
//  StoredFile. Guests only when asked. Nothing is sent.
//
//  Never copied: invitations as sent (each copied guest gets a fresh,
//  unsent one, which is how a guest's days are recorded), RSVPs, check-ins,
//  Memory Hub photos and videos, documents, tickets and sales, Event
//  Passes, SMS bundles, reminder schedules and logs, announcements, short
//  links, share tokens (the copy gets its own), feedback and consent,
//  retention claims, the source's team assignments.
//
//  It creates an event, so it is held to the plan's active-event limit
//  exactly like creating one (403 EVENT_LIMIT_REACHED), re-counted under the
//  tenant's event-creation lock in the same transaction that writes the copy,
//  and to the creation gates for what it carries (public, paid, additional
//  fields, document fields).
//
//  All or nothing: the files are copied first (network calls never run
//  inside a transaction), then everything else is written in one
//  transaction. If anything fails after a file was copied, every copied
//  file is requested for deletion and deleted at once where possible.
//
//  copyEvent is the engine, for any caller that has already decided the
//  source may be copied (later: a plan granting events). duplicate is the
//  organiser route's entry: it scopes the source first.
// ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

const parseFirstDate = (value: unknown, now: Date): Date => {
  const match = typeof value === 'string' ? DATE_PREFIX.exec(value.trim()) : null;
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !date || Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(match[3])) {
    throw new HttpError(422, "Choose the new event's first date.", DUPLICATE_ERROR_CODES.DATE_INVALID);
  }
  // The day rule (STEERING "Event days and program items: dates"): today in
  // UTC minus one day of slack is the earliest.
  if (date.getTime() < earliestAllowedDayDate(now).getTime()) {
    throw new HttpError(422, "The new event's first date has already passed. Choose today or a later date.", EVENT_DAY_DATE_IN_PAST);
  }
  return date;
};

// The request, checked: a name (as creating an event requires), a first
// date, and copyGuests (a boolean when sent; off by default).
export const parseDuplicateRequest = (body: unknown, now: Date = new Date()): DuplicateOptions => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Send the new name, first date and whether to copy guests.');
  }
  const b = body as Record<string, unknown>;
  const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
  if (!name) throw new HttpError(422, 'Your event needs a name.');
  const firstDate = parseFirstDate(b['firstDate'], now);
  const copyGuests = b['copyGuests'];
  if (copyGuests !== undefined && typeof copyGuests !== 'boolean') {
    throw new HttpError(400, 'copyGuests must be true or false.');
  }
  return { name, firstDate, copyGuests: copyGuests === true };
};

const utcMidnight = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export interface CopyEventInput extends DuplicateOptions {
  // Who makes the copy: its createdBy, and the uploader of its files.
  userId: string;
  // Assign the copy to this user (a locked member making it). Default: the
  // creator rule (isCreatorLocked), as on every create path.
  assignCreator?: boolean;
}

export interface CopyEventResult {
  eventId: string;
  summary: DuplicationSummary;
}

export const eventDuplicateService = {
  // POST /api/events/:id/duplicate. The source is any event the caller can
  // manage, archived ones included (read only: nothing about it changes);
  // another tenant's, or an unassigned one for a locked member, is the same
  // 404 as everywhere. The response is the copy as GET /api/events/:id
  // returns it, plus `duplication`.
  duplicate: async (sourceEventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, body: unknown) => {
    const options = parseDuplicateRequest(body);
    const source = await eventService.getById(sourceEventId, requestingRole, tenantId, true);
    const { eventId, summary } = await eventDuplicateService.copyEvent(source.id, { ...options, userId });
    const event = await eventService.getDetail(eventId, requestingRole, tenantId);
    return { ...event, duplication: summary };
  },

  copyEvent: async (sourceEventId: string, input: CopyEventInput, now: Date = new Date()): Promise<CopyEventResult> => {
    const source = await eventDuplicateRepository.findSource(sourceEventId);
    const tenantId = source.tenantId;

    if (input.copyGuests && source.visibility === 'PUBLIC') {
      throw new HttpError(
        422,
        "A public event's guests registered themselves, so they can't be copied. Duplicate it without guests, and share the new event's registration link.",
        DUPLICATE_ERROR_CODES.GUESTS_PUBLIC_EVENT
      );
    }

    // ── The creation rules, before anything is written or copied ──
    // A question type the copy may not have (a document question while
    // document fields are off) is refused as a new one would be.
    for (const field of source.rsvpFields) requireFieldType(field.fieldType, field.label);
    assertPaidTicketingAvailable(source.ticketing);
    assertPublicEventsAvailable(source.visibility);
    await assertEventCreatable(tenantId, {
      visibility: source.visibility,
      ticketing: source.ticketing,
      hasCustomRsvpFields: source.rsvpFields.length > 0,
    });
    if (source.ticketing === 'PAID') await assertTenantReadyToSellTickets(tenantId);

    // ── Dates: every one moves by the same whole number of days ──
    const firstDay = source.eventDays[0];
    const shiftMs = firstDay ? input.firstDate.getTime() - utcMidnight(firstDay.date) : 0;
    const shift = (d: Date | null): Date | null => (d ? new Date(d.getTime() + shiftMs) : null);
    const cleared: ClearedDateField[] = [];
    // A deadline the shift leaves in the past would close the copy before
    // it opens: left empty instead, and reported.
    let rsvpDeadline = shift(source.rsvpDeadline);
    if (rsvpDeadline && hasDeadlinePassed(rsvpDeadline, now)) {
      rsvpDeadline = null;
      cleared.push('rsvpDeadline');
    }
    let registrationClosesAt = shift(source.registrationClosesAt);
    if (registrationClosesAt && hasDeadlinePassed(registrationClosesAt, now)) {
      registrationClosesAt = null;
      cleared.push('registrationClosesAt');
    }

    const newEventId: string = crypto.randomUUID();
    const dayIds: string[] = source.eventDays.map(() => crypto.randomUUID());
    const dayIdFor = new Map(source.eventDays.map((d, i) => [d.id, dayIds[i]!]));

    // ── Guests, when asked: the plan's guest limit checked first ──
    const guests = input.copyGuests ? await eventDuplicateRepository.findGuestsToCopy(source.id) : [];
    const guestRows = guests.map((g) => {
      const mapped = [...new Set(g.invites.flatMap((i) => i.inviteEventDay.map((d) => dayIdFor.get(d.eventDayId))))].filter(
        (id): id is string => !!id
      );
      return {
        firstName: g.firstName,
        surname: g.surname,
        email: g.email,
        phoneNumber: g.phoneNumber,
        plusOnesAllowed: g.plusOnesAllowed,
        // Only days removed from the source: invited to every day of the
        // copy, never to none (a guest always has a day).
        eventDayIds: mapped.length > 0 ? mapped : dayIds,
      };
    });
    const entitlementEvent = {
      id: newEventId,
      tenantId,
      eventPass: null,
      eventDays: source.eventDays.map((d, i) => ({ ...d, id: dayIds[i]!, date: shift(d.date)! })),
    };
    if (guestRows.length > 0) await assertGuestsCreatable(entitlementEvent, guestRows.length);

    const assignCreator = input.assignCreator ?? (await isCreatorLocked(input.userId));

    // ── Files: copied before the transaction, deleted if it fails ──
    const copiedFileIds: string[] = [];
    const summary: DuplicationSummary = {
      sourceEventId: source.id,
      shiftDays: Math.round(shiftMs / DAY_MS),
      coverCopied: false,
      designCopied: false,
      coverMissing: false,
      designMissing: false,
      guestsCopied: guestRows.length,
      clearedDates: cleared,
    };

    try {
      let cover: CopiedFile | null = null;
      if (source.coverImagePublicId) {
        cover = await storedFileService.copyFile({
          source: {
            publicId: source.coverImagePublicId,
            resourceType: 'IMAGE',
            status: source.coverFile?.status ?? (await eventDuplicateRepository.findFileStatus(source.coverImagePublicId)),
          },
          kind: 'COVER',
          tenantId,
          eventId: newEventId,
          uploadedByUserId: input.userId,
        }, now);
        if (cover) copiedFileIds.push(cover.fileId);
        summary.coverCopied = !!cover;
        summary.coverMissing = !cover;
      }

      const design = source.invitationDesigns[0] ?? null;
      let designFile: CopiedFile | null = null;
      if (design?.kind === 'UPLOAD' && design.cloudinaryPublicId) {
        designFile = await storedFileService.copyFile({
          source: {
            publicId: design.cloudinaryPublicId,
            resourceType: 'IMAGE',
            status: design.storedFile?.status ?? (await eventDuplicateRepository.findFileStatus(design.cloudinaryPublicId)),
          },
          kind: 'INVITATION_DESIGN',
          tenantId,
          eventId: newEventId,
          uploadedByUserId: input.userId,
        }, now);
        if (designFile) copiedFileIds.push(designFile.fileId);
        summary.designCopied = !!designFile;
        summary.designMissing = !designFile;
      } else if (design?.kind === 'TEMPLATE') {
        summary.designCopied = true;
      }

      const audit = { createdBy: input.userId, updatedBy: input.userId };

      await prisma.$transaction(async (tx) => {
        // The plan's event limit, counted again under the creation lock.
        await eventRepository.lockEventCreation(tx, tenantId);
        await assertWithinEventLimit(tenantId, tx);

        await eventDuplicateRepository.createEvent(tx, {
          id: newEventId,
          tenantId,
          createdByUserId: input.userId,
          name: input.name,
          description: source.description,
          // An uploaded cover becomes its copy; one already gone, none; an
          // external link (no file of ours) is kept as it is.
          coverImageUrl: source.coverImagePublicId ? (cover?.secureUrl ?? null) : source.coverImageUrl,
          coverImagePublicId: cover?.publicId ?? null,
          coverFileId: cover?.fileId ?? null,
          status: 'DRAFT',
          visibility: source.visibility,
          ticketing: source.ticketing,
          hostName: source.hostName,
          rsvpDeadline,
          capacity: source.capacity,
          registrationEmailDomains: source.registrationEmailDomains,
          registrationCap: source.registrationCap,
          registrationClosesAt,
          registrationPlusOnesAllowed: source.registrationPlusOnesAllowed,
          registrationAutoApprove: source.registrationAutoApprove,
          ticketsRefundable: source.ticketsRefundable,
          isArchived: false,
          ...audit,
        });

        for (const [i, day] of source.eventDays.entries()) {
          await eventDuplicateRepository.createDay(tx, {
            id: dayIds[i]!,
            eventId: newEventId,
            label: day.label,
            date: shift(day.date)!,
            startTime: shift(day.startTime),
            endTime: shift(day.endTime),
            location: day.location,
            address: day.address,
            latitude: day.latitude,
            longitude: day.longitude,
            locationType: day.locationType,
            onlineUrl: day.onlineUrl,
            openForRegistration: day.openForRegistration,
            isArchived: false,
            ...audit,
          });
        }

        await eventDuplicateRepository.createFields(tx, source.rsvpFields.map((field, order) => ({
          eventId: newEventId,
          label: field.label,
          description: field.description,
          fieldType: field.fieldType,
          isRequired: field.isRequired,
          options: field.options,
          order,
          isArchived: false,
          ...audit,
        })));

        if (source.program && !source.program.isArchived) {
          const program = await eventDuplicateRepository.createProgram(tx, {
            eventId: newEventId,
            title: source.program.title,
            isPublished: source.program.isPublished,
            isArchived: false,
            ...audit,
          });
          // An item on a day removed from the source isn't shown anywhere,
          // so it isn't copied.
          const items = source.program.programItems.filter((item) => item.eventDayId === null || dayIdFor.has(item.eventDayId));
          await eventDuplicateRepository.createProgramItems(tx, items.map((item, order) => ({
            programId: program.id,
            eventDayId: item.eventDayId === null ? null : dayIdFor.get(item.eventDayId)!,
            title: item.title,
            description: item.description,
            startTime: shift(item.startTime)!,
            durationMins: item.durationMins,
            order,
            isArchived: false,
            ...audit,
          })));
        }

        // Memory Hub settings; a public hub gets its own share link.
        const hub = source.memoryHub;
        const hubPublic = !!hub && hub.isPublic && !hub.isArchived;
        await eventDuplicateRepository.createMemoryHub(tx, {
          eventId: newEventId,
          title: hub?.title ?? null,
          description: hub?.description ?? null,
          isPublic: hubPublic,
          shareToken: hubPublic ? crypto.randomBytes(32).toString('hex') : null,
          opensAt: shift(hub?.opensAt ?? null),
          isArchived: false,
          ...audit,
        });

        if (design?.kind === 'TEMPLATE') {
          await eventDuplicateRepository.createDesign(tx, {
            eventId: newEventId,
            kind: 'TEMPLATE',
            templateId: design.templateId,
            templateVersion: design.templateVersion,
            ...(design.overrides !== null && { overrides: design.overrides as Prisma.InputJsonValue }),
            isArchived: false,
            ...audit,
          });
        } else if (design?.kind === 'UPLOAD' && designFile) {
          await eventDuplicateRepository.createDesign(tx, {
            eventId: newEventId,
            kind: 'UPLOAD',
            imageUrl: designFile.secureUrl,
            cloudinaryPublicId: designFile.publicId,
            storedFileId: designFile.fileId,
            width: design.width,
            height: design.height,
            altText: design.altText,
            isArchived: false,
            ...audit,
          });
        }

        // The copied files now belong to the copy.
        for (const fileId of copiedFileIds) await storedFileService.attach(tx, fileId, { eventId: newEventId }, now);

        if (assignCreator) await eventAssignmentRepository.create(tx, tenantId, input.userId, newEventId, input.userId);

        if (guestRows.length > 0) {
          await assertGuestsCreatable(entitlementEvent, guestRows.length, tx);
          await guestRepository.bulkCreateWithInvites(newEventId, input.userId, guestRows, tx);
        }
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (err) {
      // Never hides the refusal: a cleanup that fails is logged, and the
      // unsaved-uploads sweep requests the files within 24 hours anyway
      // (they were never attached).
      if (copiedFileIds.length > 0) {
        try {
          await storedFileService.requestDeletion(prisma, { id: { in: copiedFileIds } }, now);
          await storageDeletionWorker.deleteNow(copiedFileIds, now);
        } catch (cleanupErr) {
          console.error('[event-duplicate] couldn\'t request the copied files\' deletion; the unsaved-uploads sweep will', cleanupErr);
        }
      }
      throw err;
    }

    return { eventId: newEventId, summary };
  },
};
