import { type CheckInPassKind } from '@prisma/client';
import { findTicket, ticketAdmits, ticketAdmitsDay, ticketDetail, type TicketForCheckIn } from '../check-in/ticket-check-in.js';
import { checkInPassRepository, type PassRow, type RsvpParty } from './check-in-pass.repository.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';

// ─────────────────────────────────────────
//  WHAT EACH KIND OF PASS IS VALID FOR
//
//  The scan flow (check-in-scan.service.ts) never knows how a pass came to
//  be: it asks the pass's kind who the pass admits, now. Issuing asks the
//  same rules what passes should exist. One answer for both, so a code
//  can't scan for something its issuing would no longer give.
//
//  RSVP (here): an accepted guest and each of their plus-ones, one pass per
//  day they said yes to that has a venue. Ticket sales add TICKET with its
//  own rules beside it; the scan flow and its result stay as they are.
// ─────────────────────────────────────────

export interface PassHolder {
  // The person admitted: the guest, or the plus-one's own Guest row. This is
  // whose check-in is recorded (their invite's CheckIn row for the day).
  personGuestId: string;
  name: string;
  isPlusOne: boolean;
  // The guest a plus-one came with; null for the guest themselves.
  guestOfName: string | null;
}

export interface WantedPass {
  eventDayId: string;
  plusOneGuestId: string | null;
  holder: PassHolder;
}

// Why a pass that exists is no longer wanted, for revokeReason.
export type RevokeReason = 'RSVP_CHANGED' | 'DECLINED' | 'GUEST_REMOVED' | 'REGISTRATION_DECLINED' | 'EVENT_CANCELLED' | 'NO_LONGER_VALID';

export interface PartyPasses {
  // Every pass this party should hold right now (person + day).
  wanted: WantedPass[];
  // The reason any other active pass of theirs is revoked.
  revokeReason: RevokeReason;
}

export interface PassKindRules {
  // Who this pass admits now, or null if it no longer admits anyone.
  resolveHolder(pass: PassRow): Promise<PassHolder | null>;
}

export const displayName = (person: { firstName: string | null; surname: string | null } | null | undefined): string =>
  [person?.firstName, person?.surname].filter(Boolean).join(' ').trim() || 'Guest';

const acceptedDayIds = (invites: RsvpParty['invites']): Set<string> =>
  new Set(invites.filter((i) => i.status === 'ACCEPTED').flatMap((i) => i.attendances.map((a) => a.eventDayId)));

// RSVP passes for a party (the guest who RSVP'd and their plus-ones), read
// from the party as it is now:
// - none on a cancelled or draft event, or an archived one;
// - none on a public event selling tickets (ticketing PAID, while the
//   `ticketing` flag is on): there the ticket is the pass (ticket sales
//   Round B), and a free registration from before sales were switched on
//   loses its RSVP pass. A paid PRIVATE event (the invitation purchase path,
//   from before 2026-11, which Round B removes) keeps them: it has no ticket
//   pass to replace them;
// - none for a removed guest, a registration awaiting approval or declined;
// - none unless the guest has accepted;
// - one per person per day they said yes to, for live days with a venue
//   (an online day has no door). A plus-one attends their host's days.
export const rsvpPartyPasses = (party: RsvpParty): PartyPasses => {
  const none = (revokeReason: RevokeReason): PartyPasses => ({ wanted: [], revokeReason });
  const { event } = party;

  if (event.status === 'CANCELLED') return none('EVENT_CANCELLED');
  if (event.status === 'DRAFT' || event.isArchived) return none('NO_LONGER_VALID');
  if (event.ticketing === 'PAID' && event.visibility === 'PUBLIC' && isFeatureEnabled('ticketing')) return none('NO_LONGER_VALID');
  if (party.isArchived) return none('GUEST_REMOVED');
  if (party.registrationDeclinedAt) return none('REGISTRATION_DECLINED');
  if (party.pendingApproval) return none('NO_LONGER_VALID');

  const guestDays = acceptedDayIds(party.invites);
  if (guestDays.size === 0) {
    return none(party.invites.some((i) => i.status === 'DECLINED') ? 'DECLINED' : 'RSVP_CHANGED');
  }

  // Live days with a venue. A null type is a venue (STEERING "Venue").
  const doorDays = event.eventDays.filter((d) => d.locationType !== 'ONLINE').map((d) => d.id);
  const guestName = displayName(party);
  const wanted: WantedPass[] = [];

  for (const dayId of doorDays) {
    if (guestDays.has(dayId)) {
      wanted.push({ eventDayId: dayId, plusOneGuestId: null, holder: { personGuestId: party.id, name: guestName, isPlusOne: false, guestOfName: null } });
    }
    for (const plusOne of party.plusOnes) {
      if (!acceptedDayIds(plusOne.invites).has(dayId)) continue;
      wanted.push({
        eventDayId: dayId,
        plusOneGuestId: plusOne.id,
        holder: { personGuestId: plusOne.id, name: displayName(plusOne), isPlusOne: true, guestOfName: guestName },
      });
    }
  }
  return { wanted, revokeReason: 'RSVP_CHANGED' };
};

export const passKey = (p: { eventDayId: string; plusOneGuestId: string | null }): string => `${p.eventDayId}:${p.plusOneGuestId ?? ''}`;

const rsvpRules: PassKindRules = {
  resolveHolder: async (pass) => {
    const party = await checkInPassRepository.findParty(pass.guestId);
    if (!party || party.eventId !== pass.eventId) return null;
    const match = rsvpPartyPasses(party).wanted.find((w) => passKey(w) === passKey(pass));
    return match?.holder ?? null;
  },
};

// TICKET (ticket sales Round B): never a CheckInPass row. The payload names
// the IssuedTicket itself; it admits its buyer's ticket, once on each venue
// day its type admitted, while the ticket is VALID and its order confirmed.
export interface TicketKindRules {
  // The ticket a payload names (whatever its state), or null if none.
  resolveTicket(ticketId: string): Promise<TicketForCheckIn | null>;
  // Whether it admits anyone now (VALID, order confirmed).
  admits(ticket: TicketForCheckIn): boolean;
  // Whether it admits someone on this day.
  admitsDay(ticket: TicketForCheckIn, dayId: string): boolean;
  // What the door person reads: the buyer, "Ticket 2 of 3 · General".
  holder(ticket: TicketForCheckIn): { name: string; detail: string };
}

const ticketRules: TicketKindRules = {
  resolveTicket: findTicket,
  admits: ticketAdmits,
  admitsDay: (ticket, dayId) => ticketAdmitsDay(ticket.item, dayId),
  holder: (ticket) => ({ name: ticket.order.buyerName, detail: ticketDetail(ticket) }),
};

export const PASS_KIND_RULES = {
  RSVP: rsvpRules,
  TICKET: ticketRules,
} satisfies Record<CheckInPassKind, PassKindRules | TicketKindRules>;
