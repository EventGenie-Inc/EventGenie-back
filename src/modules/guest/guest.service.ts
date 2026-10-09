import { guestRepository } from './guest.repository.js';
import { type CreateGuestDto, type UpdateGuestDto } from './guest.types.js';
import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import prisma from '../../shared/prisma/prisma.client.js';
import { eventService, resolveEventScope } from '../event/event.service.js';
import { eventDayRepository } from '../event-day/event-day.repository.js';
import { assertGuestsCreatable } from '../subscription-tier-config/guest-tier-enforcement.util.js';
import {
  normalizeEmail,
  assertValidEmail,
  normalizePhoneToE164,
  assertExactlyOneContact,
  assertGuestHasEmail,
  assertValidPlusOnesAllowed,
  findDuplicateEmail,
  guestEmailTaken,
  isGuestEmailUniqueViolation,
} from './guest-validation.util.js';
import { parseImportFile, validateImportRows } from './guest-import.engine.js';
import { buildImportTemplateWorkbook } from './guest-template.util.js';
import { buildGuestExportWorkbook } from './guest-export.util.js';
import { assertGuestExportEnabled } from '../subscription-tier-config/guest-export-tier-enforcement.util.js';
import { resolveTenantScope, isTenantScopeEmptyForList } from '../../shared/utils/tenant-scope.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

// PUBLIC events have no organiser-built guest list by design — guests
// self-create on RSVP. The frontend never offers add/import for a
// public event, but that's a UI choice, not a backend guarantee;
// invite send/resend already enforce this (assertEventAcceptsInvites
// in invite-dispatch.service.ts) and guest creation needs the same
// backstop.
const assertEventAcceptsOrganiserGuestList = (visibility: string): void => {
  if (visibility !== 'PRIVATE') {
    throw new HttpError(
      400,
      "Public events don't use an organiser-built guest list — guests add themselves when they RSVP."
    );
  }
};

// The unique index on a live guest's email (guest-validation.util.ts) is
// the same refusal as the pre-checks: 409 GUEST_EMAIL_TAKEN, never a 500.
const rethrowGuestEmailTaken = (err: unknown): never => {
  if (isGuestEmailUniqueViolation(err)) throw guestEmailTaken();
  throw err;
};

export const guestService = {
  // Guest has no tenantId of its own — ownership is transitive through
  // its invites' parent events. Every method gates through
  // eventService.getById() (for event-scoped operations) or an
  // invites-relation filter threaded through guestRepository (for
  // by-id/tenant-wide operations), mirroring event-day.service.ts and
  // user.service.ts respectively.

  getAll: async (requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    if (requestingRole === 'SUPER_ADMIN') return guestRepository.findAll(undefined, includeArchived);
    // A non-SUPER_ADMIN with no tenantId should never exist — fail closed
    // with an empty list rather than an unscoped, every-tenant query. See
    // tenant-scope.util.ts.
    if (isTenantScopeEmptyForList(requestingRole, tenantId)) return Promise.resolve([]);
    // The event scope (tenant + assignment lock): a locked EVENT_ADMIN sees
    // only their assigned events' guests.
    const scope = await resolveEventScope(requestingRole, tenantId);
    return guestRepository.findAll(scope.tenantId, includeArchived, scope.eventIds);
  },

  getById: async (id: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    // Tenant first, with this record's own 404 wording; then the event scope
    // adds the assignment lock (a guest of an unassigned event is a 404 too).
    resolveTenantScope(requestingRole, tenantId, 'Guest not found');
    const scope = await resolveEventScope(requestingRole, tenantId);
    const guest = await guestRepository.findById(id, includeArchived, scope.tenantId, scope.eventIds);

    if (!guest) throw new HttpError(404, 'Guest not found');
    return guest;
  },

  getAllForEvent: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null, includeArchived = false) => {
    await eventService.getById(eventId, requestingRole, tenantId); // throws 404 if wrong tenant
    return guestRepository.findAllForEvent(eventId, includeArchived);
  },

  create: async (eventId: string, userId: string, requestingRole: PlatformRole, tenantId: string | null, data: CreateGuestDto) => {
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    assertEventAcceptsOrganiserGuestList(event.visibility);

    if (!Array.isArray(data.eventDayIds) || !data.eventDayIds.length) {
      throw new HttpError(422, 'Choose at least one day to invite this guest to.');
    }
    const validDayIds = new Set(event.eventDays.map((d) => d.id));
    const unknownDayId = data.eventDayIds.find((id) => !validDayIds.has(id));
    if (unknownDayId) {
      throw new HttpError(400, `Event day '${unknownDayId}' does not belong to this event`);
    }

    // Blank (or whitespace) is "not supplied", never a stored "".
    const email = data.email?.trim() ? normalizeEmail(data.email) : null;
    if (email) assertValidEmail(email);
    const phoneNumber = data.phoneNumber?.trim() ? normalizePhoneToE164(data.phoneNumber) : null;
    // Organiser-created guests are never plus-ones — hostGuestId isn't
    // settable through this path — so contact stays required here.
    assertExactlyOneContact(email, phoneNumber);
    if (!isFeatureEnabled('sms')) assertGuestHasEmail(email);

    const plusOnesAllowed = data.plusOnesAllowed ?? 0;
    assertValidPlusOnesAllowed(plusOnesAllowed);

    // By email only: guests may share a phone (guest-validation.util.ts).
    const existingContacts = await guestRepository.findContactsForEvent(eventId);
    const duplicate = findDuplicateEmail(existingContacts.map((g) => ({ guestId: g.id, email: g.email })), email);
    if (duplicate) throw guestEmailTaken();

    await assertGuestsCreatable(event, 1);

    // Unwrapped to `.guest` — this route's response contract is (and
    // stays) the Guest row alone; the paired Invite that
    // createWithInvite now also returns is consumed by
    // event-public.service.ts's registration path instead.
    const { guest } = await guestRepository.createWithInvite(eventId, userId, {
      firstName: data.firstName ?? null,
      surname: data.surname ?? null,
      email,
      phoneNumber,
      eventDayIds: data.eventDayIds,
      plusOnesAllowed,
    }).catch(rethrowGuestEmailTaken);
    return guest;
  },

  // Checks only the fields this update changes. The "exactly one contact"
  // rule is a creation rule (guest-validation.util.ts): a guest who has
  // since given both at RSVP, or a phone-only guest kept from before sms
  // was switched off, can still have their name or plus-ones changed.
  update: async (id: string, requestingRole: PlatformRole, tenantId: string | null, data: UpdateGuestDto) => {
    const guest = await guestService.getById(id, requestingRole, tenantId);

    if (data.plusOnesAllowed !== undefined) assertValidPlusOnesAllowed(data.plusOnesAllowed);

    // A blank value clears the field like null does — it used to be
    // stored as "", which then passed as "has a contact" nowhere and as a
    // real value in exports.
    const nextEmail = data.email !== undefined
      ? (data.email === null || !data.email.trim() ? null : normalizeEmail(data.email))
      : guest.email;
    const nextPhone = data.phoneNumber !== undefined
      ? (data.phoneNumber === null || !data.phoneNumber.trim() ? null : normalizePhoneToE164(data.phoneNumber))
      : guest.phoneNumber;

    // Only when a contact field changes is the contact judged, on the
    // guest the change leaves behind. Plus-ones (hostGuestId set) never
    // have a contact and are exempt.
    if (data.email !== undefined || data.phoneNumber !== undefined) {
      if (data.email !== undefined && nextEmail) assertValidEmail(nextEmail);
      // The same duplicate rule as create: one email, one guest per event.
      // Checked only when the email actually changes.
      if (
        data.email !== undefined && nextEmail && nextEmail !== guest.email &&
        (await guestRepository.isEmailUsedByOtherGuest(guest.eventId, nextEmail, guest.id))
      ) {
        throw guestEmailTaken();
      }
      if (!guest.hostGuestId && !nextEmail && !nextPhone) {
        throw new HttpError(422, 'A guest must have either an email or a phone number');
      }
      // With sms off, a contact change can't leave a guest reachable only
      // by phone.
      if (!isFeatureEnabled('sms')) assertGuestHasEmail(nextEmail, guest.hostGuestId);
    }

    return guestRepository.update(id, {
      ...data,
      ...(data.email !== undefined && { email: nextEmail }),
      ...(data.phoneNumber !== undefined && { phoneNumber: nextPhone }),
    }).catch(rethrowGuestEmailTaken);
  },

  // Archiving a guest cascades to every one of their Invites — a bulk
  // send in Part 2 must never dispatch to an archived guest. Mirrors
  // tenant.service.ts's suspend cascade exactly: fetch the affected
  // children first, then one transaction flips the parent plus every
  // child together (no delegation to invite.repository.ts/service.ts for
  // the cascade writes themselves).
  archive: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    await guestService.getById(id, requestingRole, tenantId);

    const invites = await prisma.invite.findMany({ where: { guestId: id, isArchived: false } });

    await prisma.$transaction(async (tx) => {
      await tx.guest.update({ where: { id }, data: { isArchived: true } });
      for (const invite of invites) {
        await tx.invite.update({ where: { id: invite.id }, data: { isArchived: true } });
      }
    });

    return guestRepository.findById(id, true);
  },

  reactivate: async (id: string, requestingRole: PlatformRole, tenantId: string | null) => {
    // Must look up including archived — the whole point of reactivate is
    // to find a guest that is currently archived and un-archive them.
    await guestService.getById(id, requestingRole, tenantId, true);

    // Per the same v1 approach as tenant.service.ts's reactivate: this
    // uniformly reactivates every archived invite under this guest,
    // including any that may have been archived individually (via
    // invite.service.ts's own archive) before the guest itself was
    // archived. A future version could track archive origin (individual
    // vs cascade) to preserve an individually-archived invite through a
    // guest reactivation — out of scope for v1, matching the tenant
    // precedent's documented simplification.
    const invites = await prisma.invite.findMany({ where: { guestId: id, isArchived: true } });

    // A live guest may have this guest's email by now (archiving freed it):
    // restoring would make two, so it is refused, by the unique index if
    // not before.
    await prisma.$transaction(async (tx) => {
      await tx.guest.update({ where: { id }, data: { isArchived: false } });
      for (const invite of invites) {
        await tx.invite.update({ where: { id: invite.id }, data: { isArchived: false } });
      }
    }).catch(rethrowGuestEmailTaken);

    return guestRepository.findById(id, true);
  },

  getImportTemplate: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    const eventDays = await eventDayRepository.findAll(eventId);
    return buildImportTemplateWorkbook(event, eventDays, { emailOnly: !isFeatureEnabled('sms') });
  },

  importGuests: async (
    eventId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    file: { buffer: Buffer; originalname: string; mimetype: string }
  ) => {
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    assertEventAcceptsOrganiserGuestList(event.visibility);

    const rows = await parseImportFile(file.buffer, file.originalname, file.mimetype);
    const eventDays = await eventDayRepository.findAll(eventId);
    const existingGuests = await guestRepository.findContactsForEvent(eventId);
    const existingContacts = existingGuests.map((g) => ({ guestId: g.id, email: g.email }));

    const { totalRows, validRows, failures } = validateImportRows(rows, eventDays, existingContacts, {
      requireEmail: !isFeatureEnabled('sms'),
    });

    if (validRows.length > 0) {
      await assertGuestsCreatable(event, validRows.length);
      // A violation here is a guest added with one of these emails while
      // the file was being checked: nothing was imported (one transaction).
      await guestRepository.bulkCreateWithInvites(eventId, userId, validRows).catch(rethrowGuestEmailTaken);
    }

    return { totalRows, created: validRows.length, failed: failures.length, failures };
  },

  // Celebrate and above (assertGuestExportEnabled). Archived guests are
  // excluded — an export is a working document for the caterer/organiser
  // right now, and someone removed from the list shouldn't reach it.
  // Guests with no name yet (imported by phone, not yet RSVP'd) ARE
  // included: they're invited, and the organiser needs to see the gap,
  // not have it silently hidden. Plus-ones get their own rows (their
  // hostGuestId already comes back on every row from
  // findAllForEvent/findById elsewhere, but export additionally names the
  // host by display name via guest-export.util.ts's groupByHost/hostGuest
  // lookup, since a caterer works from names, not ids).
  exportGuests: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null) => {
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    await assertGuestExportEnabled(event);

    const guests = await guestRepository.findAllForExport(eventId);
    return buildGuestExportWorkbook(event, event.eventDays, event.rsvpFields, guests);
  },
};
