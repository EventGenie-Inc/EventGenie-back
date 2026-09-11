import { type EventStatus, type DeliveryMethod } from '@prisma/client';
import { eventRepository } from '../event/event.repository.js';
import { guestRepository } from '../guest/guest.repository.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { resolveEffectiveStatus } from '../event/event-status.util.js';
import { RSVP_BLOCK_MESSAGES } from '../rsvp/rsvp.service.js';
import { assertGuestsCreatable } from '../subscription-tier-config/guest-tier-enforcement.util.js';
import {
  normalizeEmail,
  assertValidEmail,
  normalizePhoneToE164,
  assertExactlyOneContact,
  findDuplicateContact,
} from '../guest/guest-validation.util.js';
import { type RegisterGuestDto } from './event-public.types.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';

// Fully public/unauthenticated surface — a registrant holds nothing but
// the event's shareToken, never platform credentials. Same audience and
// same rule as rsvp.service.ts's own header comment: every message here
// is written for a reader with no account and no context, and never
// leaks tenant names, internal ids, or anything about other guests.

// Guest-originated writes have no platform userId — Invite.createdBy/
// updatedBy is a plain String (not an FK), same convention as
// rsvp.service.ts's GUEST_ACTOR and memory-hub.service.ts's equivalent.
const GUEST_ACTOR = 'guest-self-registration';

// Shares COMPLETED/CANCELLED wording with rsvp.service.ts verbatim (see
// that file's export comment) — DRAFT gets its own text since a
// registrant has never RSVP'd yet, "not yet open for RSVPs" reads oddly
// before they've done anything. In practice DRAFT is defensive-only: a
// shareToken is only ever minted for an already-PUBLISHED event
// (event.service.ts's getShareLink), and publish has no reversal.
const REGISTRATION_BLOCK_MESSAGES: Partial<Record<EventStatus, string>> = {
  ...RSVP_BLOCK_MESSAGES,
  DRAFT: 'This event is not yet open for registration.',
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// Guards against a malformed/tampered body reaching a normalizer with
// the wrong type — same reasoning as rsvp.service.ts's
// assertValidSubmission: every field here arrives straight from an
// unauthenticated POST body.
const assertValidRegistration = (data: RegisterGuestDto): void => {
  if (!isNonEmptyString(data.firstName)) {
    throw new HttpError(400, "Please tell us your name to register.");
  }
  if (data.surname !== undefined && typeof data.surname !== 'string') {
    throw new HttpError(400, 'Something went wrong with your registration. Please refresh the page and try again.');
  }
  if (data.email !== undefined && typeof data.email !== 'string') {
    throw new HttpError(400, 'Something went wrong with your registration. Please refresh the page and try again.');
  }
  if (data.phoneNumber !== undefined && typeof data.phoneNumber !== 'string') {
    throw new HttpError(400, 'Something went wrong with your registration. Please refresh the page and try again.');
  }
};

// Shared by the public view AND register — an event whose visibility
// was flipped back to PRIVATE after a link was already shared, or that
// has since gone CANCELLED/COMPLETED/past its deadline, must refuse the
// same way regardless of which endpoint is asked.
const assertEventAcceptsRegistration = (event: {
  visibility: string;
  rsvpDeadline: Date | null;
  status: EventStatus;
  eventDays: { date: Date; endTime: Date | null }[];
}): void => {
  if (event.visibility !== 'PUBLIC') {
    throw new HttpError(400, "This is a private event — it doesn't use public registration. Contact the organiser for an invitation.");
  }

  const effectiveStatus = resolveEffectiveStatus(event);
  if (effectiveStatus !== 'PUBLISHED') {
    throw new HttpError(403, REGISTRATION_BLOCK_MESSAGES[effectiveStatus] ?? 'This event is not currently accepting registrations.');
  }

  // Independent of Event.status, same as rsvp.service.ts's own deadline
  // gate — an event can be perfectly PUBLISHED and still have
  // registration closed.
  if (event.rsvpDeadline && event.rsvpDeadline < new Date()) {
    throw new HttpError(
      410,
      `Registration for this event closed on ${formatGuestDate(event.rsvpDeadline)}. Contact the organiser if you still need to attend.`
    );
  }
};

// Deliberate, hand-picked projection — a guest sees only what belongs
// on an invitation. No tenant id, no Event.id, no createdBy/updatedBy,
// no coverImagePublicId, no capacity, no organiser-internal fields
// (invitationTemplate/invitationConfig), no raw status. Built as an
// explicit allowlist (not a spread of the Prisma row) so this can never
// silently start leaking a field added to Event later — the same
// mistake already flagged on rsvp.service.ts's validate().
const toPublicView = (event: {
  name: string;
  description: string | null;
  hostName: string | null;
  location: string;
  address: string | null;
  coverImageUrl: string | null;
  rsvpDeadline: Date | null;
  visibility: string;
  status: EventStatus;
  eventDays: { id: string; label: string; date: Date; startTime: Date | null; endTime: Date | null }[];
}) => {
  const effectiveStatus = resolveEffectiveStatus(event);
  const isPublic = event.visibility === 'PUBLIC';
  const isPublished = effectiveStatus === 'PUBLISHED';
  const isCancelled = effectiveStatus === 'CANCELLED';
  const isCompleted = effectiveStatus === 'COMPLETED';
  const isRsvpDeadlinePassed = !!event.rsvpDeadline && event.rsvpDeadline < new Date();

  return {
    name: event.name,
    description: event.description,
    hostName: event.hostName,
    location: event.location,
    address: event.address,
    coverImageUrl: event.coverImageUrl,
    rsvpDeadline: event.rsvpDeadline,
    eventDays: event.eventDays.map((d) => ({
      id: d.id,
      label: d.label,
      date: d.date,
      startTime: d.startTime,
      endTime: d.endTime,
    })),
    isPublic,
    isPublished,
    isCancelled,
    isCompleted,
    isRsvpDeadlinePassed,
    // What the frontend actually gates the registration form on — folds
    // every rule above into one flag so it doesn't have to re-derive the
    // combination itself.
    canRegister: isPublic && isPublished && !isRsvpDeadlinePassed,
  };
};

export const eventPublicService = {
  // Public, unauthenticated read — resolved purely from the shareToken.
  // Returns flags rather than throwing on a closed/cancelled/expired
  // event (same "return flags, don't throw" design as rsvp.service.ts's
  // validate() and memory-hub.service.ts's viewByShareToken), so the
  // page can still show the event's name/cover/description with a
  // "registration closed" state instead of a bare error. An
  // unrecognised/revoked token is the one case with nothing to hang
  // flags off, so it's the one genuine throw.
  viewByShareToken: async (shareToken: string) => {
    const event = await eventRepository.findByShareToken(shareToken);
    if (!event) {
      throw new HttpError(404, "This registration link isn't valid. Check the link, or ask the organiser for a new one.");
    }
    return toPublicView(event);
  },

  // Creates a Guest + Invite (via the SAME batched transaction
  // guest.service.ts's organiser create() already uses — see
  // guest.repository.ts's createWithInvite) and hands back the invite's
  // token so the registrant can be redirected straight into the
  // existing /rsvp?token=... flow. Collects only name + one contact;
  // everything else (day selection, custom fields, plus-ones, tickets)
  // is answered on that RSVP form, not here.
  register: async (shareToken: string, data: RegisterGuestDto) => {
    assertValidRegistration(data);

    const event = await eventRepository.findByShareToken(shareToken);
    if (!event) {
      throw new HttpError(404, "This registration link isn't valid. Check the link, or ask the organiser for a new one.");
    }

    assertEventAcceptsRegistration(event);

    const email = data.email ? normalizeEmail(data.email) : null;
    if (email) assertValidEmail(email);
    const phoneNumber = data.phoneNumber ? normalizePhoneToE164(data.phoneNumber) : null;
    assertExactlyOneContact(email, phoneNumber);

    // Same duplicate rule as guest.service.ts's create() (STEERING: same
    // email/phone on the same event is a duplicate) — one query, reused
    // logic (findDuplicateContact), not a re-implementation.
    const existingContacts = await guestRepository.findContactsForEvent(event.id);
    const duplicate = findDuplicateContact(
      existingContacts.map((g) => ({ guestId: g.id, email: g.email, phoneNumber: g.phoneNumber })),
      { email, phoneNumber }
    );

    if (duplicate) {
      // Same person, registering again after losing their link — hand
      // back their existing RSVP's token rather than stranding them
      // with no way back in. See the batch report for the full
      // tradeoff this accepts: anyone who knows this contact detail
      // could now fetch the same token via this endpoint too. Accepted
      // for a PUBLIC event specifically — the share link itself is
      // already circulating in an uncontrolled channel (a WhatsApp
      // group), and there is today no "resend my link" alternative that
      // would deliver the token only to its owner instead.
      const existingInvite = await inviteRepository.findLatestActiveByGuestId(duplicate.guestId);
      if (existingInvite) {
        return { token: existingInvite.token, isExistingRegistration: true };
      }

      // Edge case: the guest is still active but every one of their
      // invites has been individually archived (invite.service.ts's
      // archive does NOT cascade to the guest) — mint a fresh Invite for
      // the SAME existing guest rather than fail, or create a second
      // Guest row for a contact that already exists on this event.
      const freshInvite = await inviteRepository.create(event.id, GUEST_ACTOR, {
        guestId: duplicate.guestId,
        deliveryMethod: (email ? 'EMAIL' : 'SMS') as DeliveryMethod,
        invitedDayIds: [],
      });
      return { token: freshInvite.token, isExistingRegistration: true };
    }

    // maxGuestsPerEvent is a billing constraint the ORGANISER opted
    // into — a guest who did nothing wrong must never see plan/tier
    // language. assertGuestsCreatable's own message names the tier and
    // talks about upgrading; caught and replaced here with wording
    // aimed at the actual reader.
    try {
      await assertGuestsCreatable(event.id, event.tenantId, 1);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 403) {
        throw new HttpError(403, 'Registration for this event is currently full. Please contact the organiser directly if you still want to attend.');
      }
      throw err;
    }

    // Venue capacity (Event.capacity) is deliberately NOT checked here —
    // it's informational everywhere else in the codebase (see
    // event-capacity.util.ts: "never blocks anything") and this follows
    // that existing precedent rather than inventing a new blocking rule
    // for public events specifically. See the batch report.

    // InviteEventDay is the set of days THIS invite offers as choices —
    // rsvp.service.ts's submit() rejects any attendingDayId outside it
    // ("isn't part of this invitation"). An organiser-built guest list
    // curates this per guest (e.g. some guests invited to the reception
    // only, not the full weekend); a public self-registrant has no such
    // curation step, so they're offered every currently published day —
    // NOT an empty set, which would make the RSVP form's own day
    // selection unusable for them. (Confirmed by testing: [] here made
    // submit() reject every day as "not part of this invitation".)
    // plusOnesAllowed: 0 — no organiser step exists to set an allowance
    // for a self-registered guest; see the batch report.
    const { invite } = await guestRepository.createWithInvite(event.id, GUEST_ACTOR, {
      firstName: data.firstName.trim(),
      surname: isNonEmptyString(data.surname) ? data.surname.trim() : null,
      email,
      phoneNumber,
      eventDayIds: event.eventDays.map((d) => d.id),
      plusOnesAllowed: 0,
    });

    return { token: invite.token, isExistingRegistration: false };
  },
};
