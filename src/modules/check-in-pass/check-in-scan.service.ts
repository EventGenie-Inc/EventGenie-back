import { type PlatformRole } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventService } from '../event/event.service.js';
import { checkInService } from '../check-in/check-in.service.js';
import { tenantRepository } from '../tenant/tenant.repository.js';
import { resolveEventPlan } from '../subscription-tier-config/effective-plan.util.js';
import { tierRefusalMessage, launchUnavailableMessage } from '../subscription-tier-config/tier-refusal-wording.util.js';
import { SA_TIME_ZONE } from '../reminder-schedule/reminder-schedule-time.util.js';
import { checkInPassRepository, type PassRow } from './check-in-pass.repository.js';
import { PASS_KIND_RULES, type PassHolder } from './check-in-pass-kinds.js';
import { recordTicketArrival, type TicketForCheckIn } from '../check-in/ticket-check-in.js';
import { verifyPassPayload } from './check-in-pass-token.util.js';
import { isInvitationLink } from './invitation-link.util.js';
import { type ScanInput, type ScanRefusalReason, type ScanResult } from './check-in-pass.types.js';

// ─────────────────────────────────────────
//  SCANNING A CHECK-IN CODE AT THE DOOR
//
//  POST /api/events/:eventId/check-in/scan, for the event's organisers and
//  assigned team members (the check-in router's authenticate +
//  requireEventAdmin, then the event's own scope: eventService.getScoped,
//  which applies tenant scoping and the assignment lock). One flow for every
//  kind of pass: the payload's signature, the pass, its event, its status,
//  then its kind's rules (check-in-pass-kinds.ts) say who it admits now,
//  then its day, then the one check-in write the guest list uses
//  (checkInService.recordArrival). Ticket sales add a kind, not a step.
//
//  Every outcome a scanner can meet is a 200 with GREEN, AMBER or RED and a
//  reason code; only a malformed request (400), a day not the event's
//  (404), a draft event (409, as the guest list) or a plan without QR
//  check-in (403 QR_CHECK_IN_UNAVAILABLE) are errors. The result never
//  carries the guest's email, phone or RSVP answers, and a code of another
//  event says nothing about that event.
// ─────────────────────────────────────────

export const QR_CHECK_IN_UNAVAILABLE = 'QR_CHECK_IN_UNAVAILABLE';

const MESSAGES: Record<ScanRefusalReason, string> = {
  INVALID: "This code isn't a valid check-in code.",
  INVITATION_LINK:
    'This is the invitation, not the check-in code. Ask the guest to open their invitation and show the check-in code, or check them in from the guest list.',
  REVOKED: 'This code is no longer valid.',
  REPLACED: 'This code has been replaced. Ask the guest to open their invitation for the latest one.',
  WRONG_EVENT: "This code is for a different event.",
  WRONG_DAY: 'This code is for another day.',
  EVENT_CANCELLED: 'This event has been cancelled, so nobody can be checked in.',
  NOT_ALLOWED: "You don't have access to check guests in for this event.",
  TICKET_CANCELLED: 'This ticket has been cancelled.',
};

const red = (reason: ScanRefusalReason, extra: Partial<ScanResult> = {}): ScanResult => ({
  result: 'RED',
  reason,
  message: MESSAGES[reason],
  person: null,
  day: null,
  table: null,
  checkedInAt: null,
  checkedInBy: null,
  ...extra,
});

// "18:02", South African time: what the person at the door reads. Events
// have no timezone of their own (STEERING "Dates", Known gaps).
const clock = (at: Date): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: SA_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);

const personView = (holder: PassHolder) => ({
  guestId: holder.personGuestId,
  name: holder.name,
  isPlusOne: holder.isPlusOne,
  guestOf: holder.guestOfName,
  detail: null,
  ticketId: null,
  ticketNumber: null,
});

// A ticket's holder (ticket sales Round B): the buyer, never a guest row.
const ticketPersonView = (ticket: TicketForCheckIn) => {
  const holder = PASS_KIND_RULES.TICKET.holder(ticket);
  return { guestId: null, name: holder.name, isPlusOne: false, guestOf: null, detail: holder.detail, ticketId: ticket.id, ticketNumber: ticket.number };
};

// A ticket's QR (EVT1.<issuedTicketId>): valid once on each venue day its
// type admitted, while the ticket is VALID and its order confirmed. The
// same colours and reasons as a guest's pass; TICKET_CANCELLED for a ticket
// cancelled, refunded or charged back.
const scanTicket = async (
  ticketId: string,
  eventId: string,
  day: { id: string; label: string; date: Date; locationType: string | null },
  eventDays: { id: string; label: string; date: Date; locationType: string | null }[],
  userId: string
): Promise<ScanResult> => {
  const rules = PASS_KIND_RULES.TICKET;
  const ticket = await rules.resolveTicket(ticketId);
  if (!ticket) return red('INVALID');
  if (ticket.eventId !== eventId) return red('WRONG_EVENT');
  if (ticket.status !== 'VALID') return red('TICKET_CANCELLED');
  // Unpaid, expired or under review for a payment mismatch: never issued
  // a ticket; anything else not confirmed admits nobody.
  if (!rules.admits(ticket)) return red('TICKET_CANCELLED');

  const person = ticketPersonView(ticket);
  // Venue days only: an online day has no door.
  const venueDays = eventDays.filter((d) => d.locationType !== 'ONLINE' && rules.admitsDay(ticket, d.id));
  if (day.locationType === 'ONLINE' || !rules.admitsDay(ticket, day.id)) {
    const names = venueDays.map((d) => d.label);
    return red('WRONG_DAY', {
      message: names.length ? `This ticket is for ${names.join(', ')}.` : MESSAGES.WRONG_DAY,
      person,
      day: venueDays[0] ? { id: venueDays[0].id, label: venueDays[0].label, date: venueDays[0].date } : null,
    });
  }

  const recorded = await recordTicketArrival(ticket.id, day.id, userId);
  const dayView = { id: day.id, label: day.label, date: day.date };
  const who = `${person.name} (${person.detail})`;
  if (recorded.created) {
    return {
      result: 'GREEN',
      reason: null,
      message: `Checked in: ${who}`,
      person,
      day: dayView,
      table: null,
      checkedInAt: recorded.checkInAt.toISOString(),
      checkedInBy: null,
    };
  }
  const by = (await checkInPassRepository.findUserName(recorded.checkedBy))?.username ?? null;
  return {
    result: 'AMBER',
    reason: null,
    message: `Already checked in at ${clock(recorded.checkInAt)}${by ? ` by ${by}` : ''}: ${who}`,
    person,
    day: dayView,
    table: null,
    checkedInAt: recorded.checkInAt.toISOString(),
    checkedInBy: by,
  };
};

const isNotFound = (err: unknown): boolean => err instanceof HttpError && err.statusCode === 404;

// A pass that no longer admits anyone: REPLACED when the same person still
// holds an active pass for the pass's day (their invitation shows the new
// one), else REVOKED. Neither names anyone.
//
// The guest themselves: an active pass of theirs for that day.
// A plus-one: their own active pass for that day (a restored plus-one keeps
// their row), or else, since a plus-one is a new Guest row on every RSVP
// edit and nothing reliably ties the new row to the old (a name can be
// edited or shared), the party still bringing AT LEAST as many plus-ones
// that day as were replaced together with this one (the passes revoked in
// the same reconcile share one revokedAt).
const replacedOrRevoked = async (pass: PassRow & { revokedAt: Date | null }): Promise<ScanResult> => {
  let replaced: boolean;
  if (pass.plusOneGuestId === null) {
    replaced = (await checkInPassRepository.countActiveForDay(pass.guestId, pass.eventDayId, 'GUEST')) > 0;
  } else if ((await checkInPassRepository.countActiveForDay(pass.guestId, pass.eventDayId, pass.plusOneGuestId)) > 0) {
    replaced = true;
  } else {
    const activePlusOnes = await checkInPassRepository.countActiveForDay(pass.guestId, pass.eventDayId, 'ANY_PLUS_ONE');
    const replacedTogether = pass.revokedAt
      ? await checkInPassRepository.countPlusOnesRevokedTogether(pass.guestId, pass.eventDayId, pass.revokedAt)
      : 1;
    replaced = activePlusOnes > 0 && activePlusOnes >= replacedTogether;
  }
  return red(replaced ? 'REPLACED' : 'REVOKED');
};

export const checkInScanService = {
  scan: async (
    eventId: string,
    input: ScanInput,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<ScanResult> => {
    if (typeof input?.eventDayId !== 'string' || !input.eventDayId) {
      throw new HttpError(400, 'eventDayId is required');
    }
    const dayId = input.eventDayId;

    // The scanner's access first: another tenant's event, one a locked
    // member isn't assigned to, an archived or unknown one all answer the
    // same, before anything about the code is looked at.
    let event: Awaited<ReturnType<typeof eventService.getScopedWithPass>>;
    try {
      event = await eventService.getScopedWithPass(eventId, requestingRole, tenantId);
    } catch (err) {
      if (isNotFound(err)) return red('NOT_ALLOWED');
      throw err;
    }

    // The event's plan (an organiser-facing refusal, worded by the plan).
    const tenant = await tenantRepository.findById(event.tenantId, true);
    const plan = tenant ? await resolveEventPlan(tenant, event) : null;
    if (!plan?.values.qrCheckInEnabled) {
      throw new HttpError(
        403,
        tierRefusalMessage(
          `The ${plan?.name ?? 'current'} plan does not include QR check-in. Check guests in from the guest list, or upgrade your plan.`,
          launchUnavailableMessage('QR check-in'),
          plan
        ),
        QR_CHECK_IN_UNAVAILABLE
      );
    }

    const day = event.eventDays.find((d) => d.id === dayId);
    if (!day) throw new HttpError(404, 'Event day not found');
    if (event.status === 'CANCELLED') return red('EVENT_CANCELLED');
    if (event.status === 'DRAFT') {
      throw new HttpError(409, 'This event is still a draft. Publish it before checking guests in.');
    }

    const verified = verifyPassPayload(input.payload);
    // Not a check-in code. The invitation's own QR (its link) gets its own
    // answer, decided by the link's shape alone (invitation-link.util.ts).
    if (!verified) return red(isInvitationLink(input.payload) ? 'INVITATION_LINK' : 'INVALID');
    if (verified.kind === 'TICKET') return scanTicket(verified.passId, eventId, day, event.eventDays, userId);
    const pass = await checkInPassRepository.findById(verified.passId);
    if (!pass || pass.kind !== verified.kind) return red('INVALID');
    if (pass.eventId !== eventId) return red('WRONG_EVENT');
    if (pass.status !== 'ACTIVE') return replacedOrRevoked(pass);

    // An RSVP pass (a TICKET code never names a CheckInPass row).
    if (pass.kind !== 'RSVP') return red('INVALID');
    const holder = await PASS_KIND_RULES.RSVP.resolveHolder(pass);
    if (!holder) {
      // Out of date (an RSVP changed and its reconcile hasn't run, or
      // failed): retired now, so it answers the same next time.
      await checkInPassRepository.revoke([pass.id], 'NO_LONGER_VALID');
      return replacedOrRevoked((await checkInPassRepository.findById(pass.id)) ?? pass);
    }

    if (pass.eventDayId !== dayId) {
      const passDay = await checkInPassRepository.findDay(pass.eventDayId);
      return red('WRONG_DAY', {
        message: passDay ? `This code is for ${passDay.label}.` : MESSAGES.WRONG_DAY,
        person: personView(holder),
        day: passDay ? { id: passDay.id, label: passDay.label, date: passDay.date } : null,
      });
    }

    const recorded = await checkInService.recordArrival(eventId, dayId, holder.personGuestId, userId);
    if (!recorded) {
      // The rules said yes but the person has no live invite to the day: as
      // out of date as above.
      await checkInPassRepository.revoke([pass.id], 'NO_LONGER_VALID');
      return red('REVOKED');
    }

    const checkIn = recorded.invite.checkIns[0]!;
    const dayView = { id: day.id, label: day.label, date: day.date };
    const who = holder.isPlusOne && holder.guestOfName ? `${holder.name} (guest of ${holder.guestOfName})` : holder.name;

    if (recorded.created) {
      return {
        result: 'GREEN',
        reason: null,
        message: `Checked in: ${who}`,
        person: personView(holder),
        day: dayView,
        table: null,
        checkedInAt: checkIn.checkedInAt.toISOString(),
        checkedInBy: null,
      };
    }

    const by = (await checkInPassRepository.findUserName(checkIn.checkedBy))?.username ?? null;
    return {
      result: 'AMBER',
      reason: null,
      message: `Already checked in at ${clock(checkIn.checkedInAt)}${by ? ` by ${by}` : ''}: ${who}`,
      person: personView(holder),
      day: dayView,
      table: null,
      checkedInAt: checkIn.checkedInAt.toISOString(),
      checkedInBy: by,
    };
  },
};
