import { type rsvpResponseService } from '../rsvp-response/rsvp-response.service.js';

// The answers exactly as the guest details get them (GET
// /api/invites/:inviteId/rsvp-responses): each row with its `rsvpField`, a
// MULTI_SELECT answer's `value` as its list of options, and `document`, a
// DOCUMENT answer's kept file ({ id, fileName, contentType, sizeBytes,
// uploadedAt }) or null. Never a link: the organiser asks GET
// /api/events/:eventId/documents/:documentId/link for one.
export type PendingRegistrationAnswers = Awaited<ReturnType<typeof rsvpResponseService.getAll>>;

// GET /api/events/:eventId/registrations/pending: one per registrant
// awaiting approval (their plus-ones listed under them), oldest first.
export interface PendingRegistration {
  guestId: string;
  // Their invite, for the guest details' own reads; null only if an
  // organiser archived the invite alone.
  inviteId: string | null;
  firstName: string | null;
  surname: string | null;
  email: string | null;
  phoneNumber: string | null;
  registeredAt: Date | null;
  plusOnes: { guestId: string; firstName: string | null; surname: string | null }[];
  // The live days they said they'll attend, earliest first.
  attendingDays: { id: string; label: string; date: Date }[];
  answers: PendingRegistrationAnswers;
}

export interface PendingRegistrationList {
  registrations: PendingRegistration[];
}

// POST .../registrations/:guestId/approve and .../decline.
export interface RegistrationDecision {
  guestId: string;
  decision: 'APPROVED' | 'DECLINED';
  // Approve: the invitation email; decline: the "wasn't accepted" email.
  // false = it couldn't be sent; the decision stands either way.
  emailSent: boolean;
}
