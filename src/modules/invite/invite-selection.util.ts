import { type PlatformRole } from '@prisma/client';
import { inviteRepository } from './invite.repository.js';
import { resolveEventScope } from '../event/event.service.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { countPhrase, type CountedPhrase } from './invite-reminder.util.js';

// ─────────────────────────────────────────
//  A SELECTION WITH GUESTS WHO CAN'T BE SENT TO
//
//  Send (and a re-send of a selection, which is the same request) and
//  Remind take the organiser's ticked guests. Some may be impossible to
//  send to: removed, a plus-one, awaiting approval, on another of the
//  organiser's events. Those are left out and reported by name and
//  contact; everyone else in the selection goes as normal.
//
//  An id that is not a guest the caller may see at all (made up, another
//  tenant's, or an event the caller's assignment lock hides) refuses the
//  WHOLE request, naming nobody and no id: telling them apart, or naming
//  the guest, would reveal records outside the caller's scope.
// ─────────────────────────────────────────

export type UnsendableReason =
  | 'NOT_IN_EVENT'
  | 'REGISTRATION_DECLINED'
  | 'ARCHIVED'
  | 'PLUS_ONE'
  | 'PENDING_APPROVAL'
  | 'NO_INVITATION';

export const UNSENDABLE_MESSAGES: Record<UnsendableReason, string> = {
  NOT_IN_EVENT: "They're a guest of another event, not this one.",
  REGISTRATION_DECLINED: 'Their registration was declined.',
  ARCHIVED: "They've been removed from the guest list. Restore them first.",
  PLUS_ONE: "They're a plus-one. Their host's invitation covers them.",
  PENDING_APPROVAL: 'Their registration is waiting for your approval.',
  NO_INVITATION: 'They have no invitation. Their invitation was archived.',
};

// "2 were removed from the guest list, 1 is a plus-one": the reason given
// when a reminder leaves nobody to remind (as describeSkips). Always in the
// order below, whatever order the guests came back in.
export const describeUnsendable = (reasons: UnsendableReason[]): string =>
  (Object.keys(UNSENDABLE_PHRASES) as UnsendableReason[])
    .map((reason) => [reason, reasons.filter((r) => r === reason).length] as const)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => countPhrase(n, UNSENDABLE_PHRASES[reason]))
    .join(', ');

const UNSENDABLE_PHRASES: Record<UnsendableReason, CountedPhrase> = {
  NOT_IN_EVENT: { one: 'is a guest of another event', many: 'are guests of another event' },
  REGISTRATION_DECLINED: { one: 'had their registration declined', many: 'had their registration declined' },
  ARCHIVED: { one: 'was removed from the guest list', many: 'were removed from the guest list' },
  PLUS_ONE: { one: 'is a plus-one', many: 'are plus-ones' },
  PENDING_APPROVAL: { one: 'is awaiting your approval', many: 'are awaiting your approval' },
  NO_INVITATION: { one: 'has no invitation', many: 'have no invitation' },
};

export const GUEST_SELECTION_UNKNOWN = 'GUEST_SELECTION_UNKNOWN';

export interface UnsendableGuest {
  guestId: string;
  name: string;
  contact: string;
  reason: UnsendableReason;
  message: string;
}

const displayName = (guest: { firstName: string | null; surname: string | null }): string =>
  [guest.firstName, guest.surname].filter(Boolean).join(' ').trim() || 'Guest';

type SelectedGuest = Awaited<ReturnType<typeof inviteRepository.findSelectedGuests>>[number];

const reasonFor = (guest: SelectedGuest, eventId: string): UnsendableReason => {
  if (guest.eventId !== eventId) return 'NOT_IN_EVENT';
  if (guest.registrationDeclinedAt) return 'REGISTRATION_DECLINED';
  if (guest.isArchived) return 'ARCHIVED';
  if (guest.hostGuestId) return 'PLUS_ONE';
  if (guest.pendingApproval) return 'PENDING_APPROVAL';
  // A live guest of this event the send's own query didn't return: their
  // every invite is archived.
  return 'NO_INVITATION';
};

// `left` is the selected ids the send's own query did not return. Answers
// why each can't be sent to, or throws if any is outside the caller's
// reach. `event` is the URL's event, already gated by eventService.
export const sortOutUnsendable = async (
  event: { id: string; tenantId: string },
  left: string[],
  requestingRole: PlatformRole,
  tenantId: string | null
): Promise<UnsendableGuest[]> => {
  const ids = [...new Set(left)];
  if (!ids.length) return [];

  const guests = await inviteRepository.findSelectedGuests(ids);
  const scope = await resolveEventScope(requestingRole, tenantId);
  // The URL event's tenant, not only the caller's: a SUPER_ADMIN's
  // selection can't reach into another tenant's events either.
  const inReach = (g: SelectedGuest) =>
    g.event.tenantId === event.tenantId &&
    (scope.tenantId === undefined || g.event.tenantId === scope.tenantId) &&
    (g.eventId === event.id || scope.eventIds === undefined || scope.eventIds.includes(g.eventId));

  const reachable = guests.filter(inReach);
  if (reachable.length < ids.length) {
    const unknown = ids.length - reachable.length;
    throw new HttpError(
      400,
      `${unknown} of the selected guests ${unknown === 1 ? "isn't" : "aren't"} on your guest lists, so nothing was sent. ` +
        'Refresh the page and select again.',
      GUEST_SELECTION_UNKNOWN
    );
  }

  return reachable.map((g) => {
    const reason = reasonFor(g, event.id);
    return {
      guestId: g.id,
      name: displayName(g),
      contact: g.email ?? g.phoneNumber ?? '',
      reason,
      message: UNSENDABLE_MESSAGES[reason],
    };
  });
};
