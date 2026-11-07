import { type PlatformRole } from '@prisma/client';
import { eventService } from '../event/event.service.js';
import { eventPublicRepository } from '../event-public/event-public.repository.js';
import { inviteDispatchService } from '../invite/invite-dispatch.service.js';
import { guestDocumentService } from '../guest-document/guest-document.service.js';
import { withChoices } from '../rsvp-response/rsvp-response.service.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { registrationApprovalRepository } from './registration-approval.repository.js';
import {
  type PendingRegistration,
  type PendingRegistrationList,
  type RegistrationDecision,
} from './registration-approval.types.js';

// ─────────────────────────────────────────
//  APPROVING PUBLIC REGISTRATIONS
//
//  With Event.registrationAutoApprove off, a registration is saved awaiting
//  the organiser (Guest.pendingApproval, on the registrant and their
//  plus-ones). It holds its seats from the start, so the event can't be
//  overbooked while the organiser decides, and nothing about the event
//  reaches the registrant until it is approved
//  (registration-approval-gate.util.ts).
//
//    approve  the invitation email, exactly what auto-approve would have
//             sent at registration ("You're registered", their days, their
//             link). Not once the event has finished or been cancelled.
//    decline  a short "wasn't accepted" email; the registrant, their
//             plus-ones and their invites are archived, which frees the
//             seats. Their documents follow the archived-guest rule
//             (deleted when the event finishes unless restored first).
//             Still possible once the event has finished, so nobody waits
//             forever without an answer; not once it has been cancelled.
//
//  Undecided registrations simply stay pending: switching auto-approve on
//  approves nobody, and the event finishing declines nobody.
//
//  Every route gates on eventService.getScoped first: tenant scope and the
//  assignment lock (another tenant's event, an archived one or a locked
//  member's: 404). A guest who isn't a registrant of THIS event is
//  REGISTRATION_NOT_FOUND (404), whichever tenant they belong to.
// ─────────────────────────────────────────

export const REGISTRATION_APPROVAL_ERROR_CODES = {
  NOT_FOUND: 'REGISTRATION_NOT_FOUND',
  ALREADY_APPROVED: 'REGISTRATION_ALREADY_APPROVED',
  ALREADY_DECLINED: 'REGISTRATION_ALREADY_DECLINED',
  // Pending, but an organiser removed the guest: restore them first.
  GUEST_REMOVED: 'REGISTRATION_GUEST_REMOVED',
  EVENT_CANCELLED: 'REGISTRATION_DECISION_EVENT_CANCELLED',
  EVENT_FINISHED: 'REGISTRATION_DECISION_EVENT_FINISHED',
} as const;

const CODES = REGISTRATION_APPROVAL_ERROR_CODES;

type ScopedEvent = Awaited<ReturnType<typeof eventService.getScoped>>;
type Guest = NonNullable<Awaited<ReturnType<typeof registrationApprovalRepository.findGuest>>>;
type Decision = RegistrationDecision['decision'];

// Why this guest can't be decided on now, or null if they can.
const refusalFor = (guest: Guest | null): HttpError | null => {
  if (!guest || guest.hostGuestId !== null || guest.selfRegisteredAt === null) {
    return new HttpError(404, "This registration couldn't be found.", CODES.NOT_FOUND);
  }
  if (guest.registrationDeclinedAt) {
    return new HttpError(409, 'This registration has already been declined.', CODES.ALREADY_DECLINED);
  }
  // Approved by an organiser, or registered while auto-approve was on.
  if (!guest.pendingApproval) {
    return new HttpError(409, 'This registration has already been approved.', CODES.ALREADY_APPROVED);
  }
  if (guest.isArchived) {
    return new HttpError(
      409,
      'This registration was removed from the guest list. Restore the guest to approve or decline it.',
      CODES.GUEST_REMOVED
    );
  }
  return null;
};

const assertEventAllows = (event: ScopedEvent, decision: Decision): void => {
  if (event.status === 'CANCELLED') {
    throw new HttpError(
      409,
      "This event has been cancelled, so its registrations can't be approved or declined.",
      CODES.EVENT_CANCELLED
    );
  }
  if (decision === 'APPROVED' && event.status === 'COMPLETED') {
    throw new HttpError(
      409,
      'This event has already taken place, so registrations can no longer be approved. You can still decline them.',
      CODES.EVENT_FINISHED
    );
  }
};

// The guest, checked, then the write, conditional on them still being
// pending. A lost race re-reads the guest to say what decided it first.
const decide = async (event: ScopedEvent, guestId: string, decision: Decision, userId: string): Promise<Guest> => {
  const guest = await registrationApprovalRepository.findGuest(event.id, guestId);
  const refusal = refusalFor(guest);
  if (refusal) throw refusal;
  assertEventAllows(event, decision);

  const write = decision === 'APPROVED' ? registrationApprovalRepository.approve : registrationApprovalRepository.decline;
  if (!(await write(event.id, guestId, userId, new Date()))) {
    throw (
      refusalFor(await registrationApprovalRepository.findGuest(event.id, guestId)) ??
      new HttpError(409, 'This registration was just changed. Refresh and try again.', CODES.ALREADY_APPROVED)
    );
  }
  return guest!;
};

export const registrationApprovalService = {
  listPending: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<PendingRegistrationList> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    const guests = await registrationApprovalRepository.findPending(event.id);
    const inviteIds = guests.flatMap((g) => g.invites.map((i) => i.id));
    const answers = (await guestDocumentService.withDocumentInfo(await registrationApprovalRepository.findAnswers(inviteIds))).map(
      withChoices
    );

    const registrations: PendingRegistration[] = guests.map((g) => {
      const invite = g.invites[0] ?? null;
      return {
        guestId: g.id,
        inviteId: invite?.id ?? null,
        firstName: g.firstName,
        surname: g.surname,
        email: g.email,
        phoneNumber: g.phoneNumber,
        registeredAt: g.selfRegisteredAt,
        plusOnes: g.plusOnes.map((p) => ({ guestId: p.id, firstName: p.firstName, surname: p.surname })),
        attendingDays: (invite?.attendances ?? []).map((a) => a.eventDay).sort((a, b) => a.date.getTime() - b.date.getTime()),
        answers: invite ? answers.filter((a) => a.inviteId === invite.id) : [],
      };
    });
    return { registrations };
  },

  // The invitation email goes after the commit, and only from the one call
  // that won the decision: approving sends exactly one.
  approve: async (
    eventId: string,
    guestId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<RegistrationDecision> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    const guest = await decide(event, guestId, 'APPROVED', userId);

    const invite = await eventPublicRepository.findLatestInviteForGuest(guest.id);
    const email = guest.email?.trim();
    let emailSent = false;
    if (invite && email) {
      const attending = invite.attendances.map((a) => a.eventDay);
      const days = attending.length > 0 ? attending : invite.inviteEventDay.map((d) => d.eventDay);
      emailSent = (await inviteDispatchService.sendRegistrationEmail(event, invite, email, days, 'REGISTRATION')).ok;
    }
    return { guestId: guest.id, decision: 'APPROVED', emailSent };
  },

  decline: async (
    eventId: string,
    guestId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<RegistrationDecision> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    const guest = await decide(event, guestId, 'DECLINED', userId);

    const email = guest.email?.trim();
    const emailSent = email ? (await inviteDispatchService.sendRegistrationDeclinedEmail(event, guest.id, email)).ok : false;
    return { guestId: guest.id, decision: 'DECLINED', emailSent };
  },
};
