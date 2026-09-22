import { type EventStatus, type PlatformRole } from '@prisma/client';
import { checkInRepository, type RosterInvite } from './check-in.repository.js';
import { eventService } from '../event/event.service.js';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  type CheckInInput,
  type CheckInResult,
  type DayRoster,
  type DayRosterCounts,
  type DayRosterRow,
  type RsvpForDay,
  type UndoCheckInResult,
} from './check-in.types.js';

// ─────────────────────────────────────────
//  DAY-OF CHECK-IN
//
//  Check-in is recorded per EVENT DAY (CheckIn: one row per invite + day),
//  never as a single "arrived" flag — someone invited to both days of a
//  wedding can be present on Saturday and absent on Sunday.
//
//  It is NOT the Attendance table. Attendance holds each guest's RSVP answer
//  per day (written by their RSVP, rebuilt whenever they edit it); check-in
//  is whether they physically turned up. See the schema comments.
//
//  Ownership: CheckIn has no tenantId of its own — it scopes transitively
//  through its event, so every method gates on eventService.getById() first,
//  exactly like event-day / guest / invite. A day or guest belonging to
//  anyone else's event is a 404, indistinguishable from not existing.
// ─────────────────────────────────────────

const displayName = (guest: { firstName: string | null; surname: string | null } | null | undefined): string =>
  [guest?.firstName, guest?.surname].filter(Boolean).join(' ').trim() || 'Guest';

// Reading the list is always allowed. Writing is not while the event is
// still a draft (nobody has arrived at something not yet live) or once it is
// cancelled. COMPLETED is deliberately still open: the morning after is when
// someone fixes a wrong tap or adds a late arrival, and refusing then would
// force a support call. (A day's check-in is NOT restricted to "today" — an
// organiser rehearsing, or fixing yesterday, must not be blocked by a clock,
// and "today" would depend on a timezone events don't have.)
const CHECK_IN_BLOCKED: Partial<Record<EventStatus, string>> = {
  DRAFT: 'This event is still a draft. Publish it before checking guests in.',
  CANCELLED: 'This event has been cancelled, so nobody can be checked in.',
};

const assertCheckInOpen = (effectiveStatus: EventStatus): void => {
  const message = CHECK_IN_BLOCKED[effectiveStatus];
  if (message) throw new HttpError(409, message);
};

const rsvpForDay = (invite: RosterInvite): RsvpForDay => {
  if (invite.status === 'PENDING') return 'NO_RESPONSE';
  if (invite.status === 'DECLINED') return 'NO';
  return invite.attendances.length > 0 ? 'YES' : 'NO';
};

const toRow = (invite: RosterInvite): DayRosterRow => {
  const checkIn = invite.checkIns[0];
  return {
    guestId: invite.guestId,
    inviteId: invite.id,
    name: displayName(invite.guest),
    contact: invite.guest.email ?? invite.guest.phoneNumber ?? null,
    isPlusOne: invite.guest.hostGuestId !== null,
    hostName: invite.guest.hostGuest ? displayName(invite.guest.hostGuest) : null,
    rsvp: rsvpForDay(invite),
    checkedIn: !!checkIn,
    checkedInAt: checkIn ? checkIn.checkedInAt.toISOString() : null,
  };
};

// A guest can in principle hold more than one live invite for the same day
// (nothing stops an organiser adding a second). They are ONE person at the
// door, so the list carries one row per guest: the invite that has a
// check-in if any does (so an arrival is never hidden), otherwise the
// newest. `invites` arrives newest-first.
const onePerGuest = (invites: RosterInvite[]): RosterInvite[] => {
  const byGuest = new Map<string, RosterInvite>();
  for (const invite of invites) {
    const kept = byGuest.get(invite.guestId);
    if (!kept || (kept.checkIns.length === 0 && invite.checkIns.length > 0)) byGuest.set(invite.guestId, invite);
  }
  return [...byGuest.values()];
};

// What the door person searches by: alphabetical by the PRIMARY guest's
// name, with a plus-one sitting directly under their host.
const sortForDoor = (rows: DayRosterRow[]): DayRosterRow[] => {
  const key = (r: DayRosterRow) => (r.isPlusOne && r.hostName ? r.hostName : r.name).toLowerCase();
  return [...rows].sort(
    (a, b) =>
      key(a).localeCompare(key(b)) ||
      Number(a.isPlusOne) - Number(b.isPlusOne) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
};

// Every count comes from the rows themselves — one source of truth, so the
// headline numbers can never disagree with the list under them.
const countRows = (rows: DayRosterRow[]): DayRosterCounts => {
  const expected = rows.filter((r) => r.rsvp === 'YES');
  const arrived = rows.filter((r) => r.checkedIn);
  const arrivedExpected = arrived.filter((r) => r.rsvp === 'YES').length;
  return {
    invited: rows.length,
    expected: expected.length,
    noResponse: rows.filter((r) => r.rsvp === 'NO_RESPONSE').length,
    notAttending: rows.filter((r) => r.rsvp === 'NO').length,
    arrived: arrived.length,
    arrivedExpected,
    arrivedUnexpected: arrived.length - arrivedExpected,
    stillExpected: expected.length - arrivedExpected,
  };
};

// Resolves the tenant gate AND the day in one place, for all three methods.
const loadEventAndDay = async (eventId: string, dayId: string, role: PlatformRole, tenantId: string | null) => {
  // The LEAN gate: this needs only ownership, the effective status
  // (assertCheckInOpen) and the event's days (the day lookup just below) —
  // never the tickets, RSVP fields, program, Memory Hub or Event Pass that
  // getById also loads. On the door screen, where latency is felt most, that
  // was six wasted queries per call.
  const event = await eventService.getScoped(eventId, role, tenantId); // 404 for another tenant's event
  // The day must belong to THIS event: a day id from anywhere else is the
  // same 404 as one that doesn't exist.
  const day = event.eventDays.find((d) => d.id === dayId);
  if (!day) throw new HttpError(404, 'Event day not found');
  return { event, day };
};

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'P2002';

export const checkInService = {
  // The door screen: everyone invited to the day, whether they have arrived,
  // and the day's counts.
  //
  // WHO IS LISTED — everyone invited to the day, not only those who RSVP'd
  // yes. Walk-ins and non-responders turn up constantly at real events and
  // must be findable, checkable and undoable, so the LIST has to include
  // them; each row carries `rsvp` so the door person can still see who was
  // expected. WHO IS COUNTED AS "EXPECTED" — only those who said yes to this
  // day: expected-vs-arrived is a forecast, and padding "expected" with
  // people who never answered (or said no) would make arrived/expected mean
  // nothing. The counts report the other groups separately.
  getDayRoster: async (
    eventId: string,
    dayId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<DayRoster> => {
    const { day } = await loadEventAndDay(eventId, dayId, requestingRole, tenantId);
    const invites = await checkInRepository.findRoster(eventId, dayId);
    const guests = sortForDoor(onePerGuest(invites).map(toRow));
    return { day: { id: day.id, label: day.label, date: day.date }, counts: countRows(guests), guests };
  },

  // Idempotent: checking in someone already checked in for this day is a
  // success (200, created:false, the ORIGINAL time) rather than an error. The
  // outcome the door person wants — "this guest is checked in" — is true
  // either way, a retried tap on bad wifi or two staff scanning the same
  // person must not look like a failure, and the response still says it was a
  // repeat so the UI can show "already in since 18:32".
  checkIn: async (
    eventId: string,
    dayId: string,
    input: CheckInInput,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<CheckInResult> => {
    const { event, day } = await loadEventAndDay(eventId, dayId, requestingRole, tenantId);
    assertCheckInOpen(event.status);

    const hasGuestId = typeof input?.guestId === 'string' && input.guestId.length > 0;
    const hasToken = typeof input?.inviteToken === 'string' && input.inviteToken.length > 0;
    if (hasGuestId === hasToken) {
      throw new HttpError(400, 'Provide exactly one of guestId or inviteToken.');
    }

    let guestId = input.guestId as string;
    if (hasToken) {
      const match = await checkInRepository.findGuestIdByToken(eventId, input.inviteToken as string);
      if (!match) throw new HttpError(404, 'No invitation matches that code for this event.');
      guestId = match.guestId;
    }

    const invites = await checkInRepository.findGuestInvites(eventId, guestId, dayId);
    if (!invites.length) {
      const guest = await checkInRepository.findGuestOnEvent(eventId, guestId);
      if (!guest) throw new HttpError(404, 'Guest not found');
      throw new HttpError(422, `${displayName(guest)} isn't invited to ${day.label}, so they can't be checked in for that day.`);
    }

    const already = onePerGuest(invites)[0]!;
    if (already.checkIns.length) return { created: false, guest: toRow(already) };

    try {
      const created = await checkInRepository.create(already.id, dayId, userId);
      return { created: true, guest: toRow({ ...already, checkIns: [created] }) };
    } catch (err) {
      // Lost a race with another tap on the same guest+day: the unique
      // (invite, day) row already exists, which is exactly the "already
      // checked in" outcome — read it back rather than fail.
      if (!isUniqueViolation(err)) throw err;
      const reread = await checkInRepository.findGuestInvites(eventId, guestId, dayId);
      return { created: false, guest: toRow(onePerGuest(reread)[0]!) };
    }
  },

  // Undo a wrong tap. Attendance-style hard delete: the row is removed
  // outright, there is nothing to restore. Idempotent like check-in —
  // undoing someone not checked in is a 200 with removed:false, since the
  // door person's goal ("they are not checked in") already holds.
  undo: async (
    eventId: string,
    dayId: string,
    guestId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<UndoCheckInResult> => {
    const { event } = await loadEventAndDay(eventId, dayId, requestingRole, tenantId);
    assertCheckInOpen(event.status);

    const guest = await checkInRepository.findGuestOnEvent(eventId, guestId);
    if (!guest) throw new HttpError(404, 'Guest not found');

    const { count } = await checkInRepository.deleteForGuestDay(eventId, guestId, dayId);
    const invites = await checkInRepository.findGuestInvites(eventId, guestId, dayId);
    return { removed: count > 0, guest: invites.length ? toRow(onePerGuest(invites)[0]!) : null };
  },
};
