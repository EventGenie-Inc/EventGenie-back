import { type PlatformRole, type DeliveryMethod } from '@prisma/client';
import { inviteRepository } from './invite.repository.js';
import { inviteService } from './invite.service.js';
import { eventService } from '../event/event.service.js';
import { assertSmsSendable, type SmsSendPool } from '../subscription-tier-config/sms-tier-enforcement.util.js';
import { inviteReminderLogRepository } from '../invite-reminder-log/invite-reminder-log.repository.js';
import { smsDestinationFor } from '../../shared/messaging/sms-number.util.js';
import { sendEmail, sendEmailBatch, type InlineImage } from '../../shared/messaging/email.engine.js';
import { emailSendService, NOT_QUEUED_MESSAGES } from '../email-send/email-send.service.js';
import { type EnqueueResult, type NotQueuedReason } from '../email-send/email-send.types.js';
import { inviteQrImage } from './invite-qr.util.js';
import {
  buildInviteRsvpLink,
  buildInviteEmail,
  buildInviteSmsBody,
  buildReminderEmail,
  buildReminderSmsBody,
  buildRegistrationEmail,
  buildRegistrationDeclinedEmail,
  buildRegistrationResendEmail,
  type BuiltEmail,
  type InviteDayLine,
  type InviteEmailDesign,
} from './invite-message.util.js';
import { invitationDesignRepository } from '../invitation-design/invitation-design.repository.js';
import { userRepository } from '../user/user.repository.js';
import {
  REMINDER_COOLDOWN_HOURS,
  REMINDER_COOLDOWN_MS,
  SKIP_MESSAGES,
  assertRsvpDeadlineNotPassed,
  classifyGuestForReminder,
  describeSkips,
  type ReminderInvite,
  type ReminderSkipReason,
} from './invite-reminder.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatEarliestDay } from '../../shared/utils/guest-date.util.js';
import { assertEventIsPublished } from '../event/event-status.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { sortOutUnsendable, describeUnsendable, type UnsendableGuest, type UnsendableReason } from './invite-selection.util.js';

// Bulk invite orchestrator — knows guests/invites/tiers and routes each
// guest to whichever engine matches their contact. Kept separate from
// invite.service.ts (which stays pure CRUD) since dispatch has its own
// dependency set: engines, tier enforcement, message builders, sms log.
// Never touches the Resend SDK or an SMS provider directly.
//
// Reminders (remindBulk) go through this SAME dispatch — one dispatch
// path, one place a message is queued and an SMS is counted. The only
// differences between an invitation and a reminder are the words, and
// that a reminder must not touch Invite.deliveredAt.
//
// Invitation and reminder EMAILS and TEXTS (bulk and a single resend) are
// queued, not sent here, one item each under one send, and go from the
// email-send worker (email-send.worker.ts): an email one Resend call each
// (it carries the guest's QR code, which the batch endpoint can't take), a
// text one SMSPortal call each, both paced. The request answers at once
// with the send's id; GET .../invites/sends/:id reports progress. Queueing
// never adds a message a guest is already waiting for or got in the last
// few minutes (email-send.service.ts). A text that can't go at all (sms
// off, a number that can't take one) is refused here, before anything is
// queued, and reported in `failures`. Announcements and the cancellation
// email carry no image and still go through sendEmailBatch, up to 100 per
// call, in the request.

export interface InviteDispatchFailure {
  guestId: string;
  name: string;
  contact: string;
  reason: string;
  // Why, for the client: SMS_UNAVAILABLE, or an SMS_NUMBER_* code
  // (sms-number.util.ts).
  code?: string;
}

// A guest whose email wasn't queued (email-send.service.ts): already on
// its way, or sent minutes ago. `sendId` is the send that has it.
export interface NotQueuedGuest {
  guestId: string;
  name: string;
  contact: string;
  reason: NotQueuedReason;
  message: string;
  sendId: string;
}

// A selected guest who couldn't be sent to at all (invite-selection.util.ts):
// named by name and contact, with sendId null since no send has them.
export type UnsendableSkip = UnsendableGuest & { sendId: null };
export type SendSkip = NotQueuedGuest | UnsendableSkip;

// POST /invites/send. queued + sent + failed + skipped counts every guest
// selected. Emails and texts are queued (sendId: their send, null if none
// was); `sent` is always 0 now that nothing goes in the request (kept for
// the shape); failed/failures are texts refused before queueing (sms off,
// a number that can't take a text). skippedGuests: those who can't be sent
// to (removed, plus-one, …) first, then those whose message was already on
// its way.
export interface SendInvitesResult {
  totalSelected: number;
  sendId: string | null;
  queued: number;
  sent: number;
  failed: number;
  failures: InviteDispatchFailure[];
  skipped: number;
  skippedGuests: SendSkip[];
}

// POST /invites/:id/resend. An email or a text is QUEUED (or not:
// ALREADY_QUEUED, RECENTLY_SENT, with `reason` saying so and `sendId` the
// send that has it). FAILED: a text refused before queueing, with `reason`
// and `code`.
export interface InviteDispatchOutcome {
  guestId: string;
  name: string;
  contact: string;
  deliveryMethod: DeliveryMethod;
  status: 'QUEUED' | NotQueuedReason | 'FAILED';
  sendId: string | null;
  reason?: string;
  code?: string;
}

// reason: a reminder rule (invite-reminder.util.ts), or why the selected
// guest can't be sent to at all (invite-selection.util.ts).
export interface ReminderSkip {
  guestId: string;
  name: string;
  contact: string;
  reason: ReminderSkipReason | UnsendableReason;
  message: string;
  // Only for RECENTLY_REMINDED — when they can next be reminded.
  nextEligibleAt?: string;
}

export interface SendRemindersResult {
  // Guests this request concerned. queued + sent + failed + skipped always
  // equals it.
  totalSelected: number;
  // Email and text reminders queued under this send (null if none was).
  sendId: string | null;
  queued: number;
  // Always 0 (nothing goes in the request); kept for the shape.
  sent: number;
  // Texts refused before queueing (sms off, a number that can't take one).
  failed: number;
  skipped: number;
  // Of `skipped`: how many were left out because they were reminded
  // within the cooldown window.
  skippedRecentlyReminded: number;
  cooldownHours: number;
  failures: InviteDispatchFailure[];
  skippedGuests: ReminderSkip[];
}

type DispatchableInvite = {
  id: string;
  guestId: string;
  token: string;
  deliveryMethod: DeliveryMethod;
  guest: { firstName: string | null; surname: string | null; email: string | null; phoneNumber: string | null; hostGuestId: string | null };
  // This guest's own invited days, with each day's venue — what the
  // email's "when and where" is built from (invite-message.util.ts).
  inviteEventDay: { eventDay: InviteDayLine & { isArchived: boolean } }[];
};

// Live days only (an archived day is no longer part of the event), earliest
// first. The repository already filters archived days on the bulk paths;
// resend loads through inviteService.getById, which does not.
const invitedDaysFor = (invite: DispatchableInvite): InviteDayLine[] =>
  invite.inviteEventDay
    .map((d) => d.eventDay)
    .filter((d) => !d.isArchived)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

const guestDisplayName = (guest: { firstName: string | null; surname: string | null }): string =>
  [guest.firstName, guest.surname].filter(Boolean).join(' ').trim() || 'Guest';

// Keyed off the Invite's own deliveryMethod (fixed at creation from
// whichever contact the guest had then), never re-derived from the
// guest's current contact fields — so a guest who adds a second contact
// at RSVP (rsvp.service.ts's submit(), which can leave them holding both
// email and phone) doesn't change how an existing invite dispatches.
const contactFor = (invite: { deliveryMethod: DeliveryMethod; guest: { email: string | null; phoneNumber: string | null } }): string =>
  invite.deliveryMethod === 'EMAIL' ? (invite.guest.email ?? '') : (invite.guest.phoneNumber ?? '');

// PUBLIC events don't use invites — they use the share link (Task 5) and
// guests self-create on RSVP. Applies to both a fresh send and a resend.
const assertEventAcceptsInvites = (visibility: string): void => {
  if (visibility !== 'PRIVATE') {
    throw new HttpError(
      400,
      "Public events don't use invitations. Share the event's public link instead."
    );
  }
};

type DispatchKind = 'INVITE' | 'REMINDER';

// With the sms feature off, a guest reachable only by SMS is a per-guest
// FAILURE the organiser sees in the results, with what to do about it;
// never a silent skip, and never a send. Email guests in the same batch go
// out as normal.
export const SMS_UNAVAILABLE_REASON =
  "Text messages aren't available yet, so nothing was sent to this guest. Add an email address for them and send again.";
export const SMS_UNAVAILABLE_CODE = 'SMS_UNAVAILABLE';

// Why a text can't go at all, or null if it can: sms switched off, or a
// number that can't take a text (sms-number.util.ts). Checked before
// anything is queued, and again by the worker when its turn comes.
export const smsRefusalFor = (phoneNumber: string | null): { reason: string; code: string } | null => {
  if (!isFeatureEnabled('sms')) return { reason: SMS_UNAVAILABLE_REASON, code: SMS_UNAVAILABLE_CODE };
  const destination = smsDestinationFor(phoneNumber);
  return destination.ok ? null : { reason: destination.reason, code: destination.code };
};

// Splits invites into emails, texts that can be queued, and texts refused
// before queueing (each a failure the organiser sees, with its code).
const sortByChannel = <T extends DispatchableInvite>(invites: T[]) => {
  const email: T[] = [];
  const sms: T[] = [];
  const refused: { invite: T; failure: InviteDispatchFailure }[] = [];
  for (const invite of invites) {
    if (invite.deliveryMethod === 'EMAIL') {
      email.push(invite);
      continue;
    }
    const refusal = smsRefusalFor(invite.guest.phoneNumber);
    if (refusal) {
      refused.push({
        invite,
        failure: { guestId: invite.guestId, name: guestDisplayName(invite.guest), contact: contactFor(invite), ...refusal },
      });
    } else {
      sms.push(invite);
    }
  }
  return { email, sms, refused };
};

export interface DispatchContext {
  eventId: string;
  tenantId: string;
  eventName: string;
  hostName: string | null;
  // Fallback only — used when a guest has no live invited day left.
  dateLabel: string | null;
  rsvpDeadline: Date | null;
  // The event's active design (an UPLOAD is shown in the email).
  design: InviteEmailDesign | null;
  // The email's Reply-To — see resolveReplyTo.
  organiserEmail: string | null;
}

// Who a guest's reply reaches, so it never lands in the no-reply sender:
//   1. the organiser who created the event, while active and not archived;
//   2. else the tenant's longest-serving active TENANT_ADMIN;
//   3. else e-velope's own admin address, from config
//      (EMAIL_FALLBACK_REPLY_TO);
//   4. else no Reply-To at all (config missing), logged.
export const resolveReplyTo = async (event: { tenantId: string; createdByUserId: string }): Promise<string | null> => {
  const creator = await userRepository.findById(event.createdByUserId);
  if (creator?.isActive && !creator.isArchived) return creator.email;
  const admin = await userRepository.findFirstActiveTenantAdmin(event.tenantId);
  if (admin) return admin.email;
  const fallback = process.env.EMAIL_FALLBACK_REPLY_TO?.trim();
  if (fallback) return fallback;
  console.error(`[invites] no Reply-To for event tenant ${event.tenantId}: EMAIL_FALLBACK_REPLY_TO is not set`);
  return null;
};

// Loaded once per batch, never per guest: at most three small queries
// whatever the batch size.
const buildDispatchContext = async (event: {
  id: string;
  tenantId: string;
  name: string;
  hostName: string | null;
  createdByUserId: string;
  rsvpDeadline: Date | null;
  eventDays: { date: Date }[];
}): Promise<DispatchContext> => {
  // A switched-off invitationDesigns feature means no design image in any
  // email; the saved design itself is left alone.
  const [design, organiserEmail] = await Promise.all([
    isFeatureEnabled('invitationDesigns') ? invitationDesignRepository.findActiveByEventId(event.id) : Promise.resolve(null),
    resolveReplyTo(event),
  ]);
  return {
    eventId: event.id,
    tenantId: event.tenantId,
    eventName: event.name,
    hostName: event.hostName,
    dateLabel: formatEarliestDay(event.eventDays),
    rsvpDeadline: event.rsvpDeadline,
    design,
    organiserEmail,
  };
};

const buildEmail = (kind: DispatchKind, ctx: DispatchContext, days: InviteDayLine[], token: string, rsvpQr: InlineImage) => {
  const input = {
    eventName: ctx.eventName,
    hostName: ctx.hostName,
    days,
    fallbackDateLabel: ctx.dateLabel,
    rsvpDeadline: ctx.rsvpDeadline,
    rsvpLink: buildInviteRsvpLink(token),
    rsvpQr,
    design: ctx.design,
    organiserEmail: ctx.organiserEmail,
  };
  return kind === 'INVITE' ? buildInviteEmail(input) : buildReminderEmail(input);
};

// One guest's text: who it's from, the event, their own SHORT link
// (<site>/r/<code>, invite-short-code.service.ts), one SMS
// (invite-message.util.ts). Built by the worker when its turn comes.
const buildSmsFor = (kind: DispatchKind, ctx: DispatchContext, shortLink: string): string =>
  kind === 'INVITE'
    ? buildInviteSmsBody(ctx.hostName, ctx.eventName, shortLink)
    : buildReminderSmsBody(ctx.hostName, ctx.eventName, shortLink, ctx.rsvpDeadline);

// One guest's email, with their own QR code (generated here, on the server).
const buildEmailFor = async (kind: DispatchKind, ctx: DispatchContext, invite: DispatchableInvite) =>
  buildEmail(kind, ctx, invitedDaysFor(invite), invite.token, await inviteQrImage(invite.token));

// Queue items for a batch: emails, and texts with the pool the batch was
// resolved (once, by assertSmsSendable) to draw from — carried on the item
// rather than re-derived when it goes, so the log can never disagree with
// what was actually enforced.
const queueItems = (email: DispatchableInvite[], sms: DispatchableInvite[], smsSource: SmsSendPool) => [
  ...email.map((i) => ({ inviteId: i.id, channel: 'EMAIL' as const })),
  ...sms.map((i) => ({ inviteId: i.id, channel: 'SMS' as const, smsSource })),
];

// The invites an enqueue left out, as the organiser sees them.
const notQueuedGuests = (invites: DispatchableInvite[], queued: EnqueueResult): NotQueuedGuest[] =>
  invites.flatMap((invite) => {
    const left = queued.notQueued.get(invite.id);
    return left
      ? [{ guestId: invite.guestId, name: guestDisplayName(invite.guest), contact: contactFor(invite), reason: left.reason, message: NOT_QUEUED_MESSAGES[left.reason], sendId: left.sendId }]
      : [];
  });

// One guest an announcement or the cancellation email goes to
// (announcement.service.ts). Only guests with an email get here: a guest
// without one is reported as unreachable before anything is sent.
export interface GuestMessageRecipient {
  guestId: string;
  name: string;
  email: string;
  inviteToken: string;
  selfRegistered: boolean;
  // A registration awaiting approval (only ever in the cancellation
  // email's audience): the builder leaves the organiser's note out.
  awaitingApproval?: boolean;
}

export interface GuestMessageOutcome {
  guestId: string;
  name: string;
  email: string;
  ok: boolean;
  reason?: string;
}

export const inviteDispatchService = {
  // Announcements and the cancellation email: one email per guest, built
  // by `build` with the event's Reply-To (resolved once, as for a batch of
  // invitations), sent through sendEmailBatch. Email only, whatever sms
  // says: an announcement is never texted. A failed send (one email, or a
  // whole batch call) is those guests' outcome, never an abort.
  sendGuestMessages: async (
    event: { tenantId: string; createdByUserId: string },
    recipients: GuestMessageRecipient[],
    build: (recipient: GuestMessageRecipient, organiserEmail: string | null) => BuiltEmail
  ): Promise<GuestMessageOutcome[]> => {
    const organiserEmail = await resolveReplyTo(event);
    const results = await sendEmailBatch(recipients.map((recipient) => ({ to: recipient.email, ...build(recipient, organiserEmail) })));
    return recipients.map((recipient, i) => {
      const result = results[i]!;
      return {
        guestId: recipient.guestId,
        name: recipient.name,
        email: recipient.email,
        ok: result.ok,
        ...(result.ok ? {} : { reason: result.reason ?? 'Delivery failed' }),
      };
    });
  },

  // Public self-registration (event-public.service.ts): emails one guest
  // their own link, right after they register or when the same email
  // registers again. Not a bulk send and never an SMS (registration
  // requires an email), but built from the same dispatch context as an
  // invitation, so the From, Reply-To and design image are the same.
  // `kind` is REGISTRATION for a guest who registered themselves, INVITE
  // for one the organiser added (their own email is the invitation).
  // Marks the invite delivered the first time a send succeeds, exactly as
  // a sent invitation does, so the guest counts as invited everywhere else.
  // Sent in the request (one email, sendEmail), not queued.
  sendRegistrationEmail: async (
    event: Parameters<typeof buildDispatchContext>[0],
    invite: { id: string; token: string; deliveredAt: Date | null },
    to: string,
    days: InviteDayLine[],
    // REGISTRATION_RESEND: the same email registering again.
    kind: 'REGISTRATION' | 'REGISTRATION_RESEND' | 'INVITE'
  ): Promise<{ ok: boolean }> => {
    const ctx = await buildDispatchContext(event);
    const input = {
      eventName: ctx.eventName,
      hostName: ctx.hostName,
      days: [...days].sort((a, b) => a.date.getTime() - b.date.getTime()),
      fallbackDateLabel: ctx.dateLabel,
      rsvpDeadline: ctx.rsvpDeadline,
      rsvpLink: buildInviteRsvpLink(invite.token),
      rsvpQr: await inviteQrImage(invite.token),
      design: ctx.design,
      organiserEmail: ctx.organiserEmail,
    };
    const email =
      kind === 'REGISTRATION' ? buildRegistrationEmail(input)
      : kind === 'REGISTRATION_RESEND' ? buildRegistrationResendEmail(input)
      : buildInviteEmail(input);
    const result = await sendEmail({ to, ...email });
    if (!result.ok) {
      // The provider's reason stays in the log; the registrant is told
      // only that the email didn't go.
      console.error(`[registration] email to invite ${invite.id} failed: ${result.reason ?? 'unknown reason'}`);
      return { ok: false };
    }
    if (!invite.deliveredAt) await inviteRepository.markDelivered(invite.id);
    return { ok: true };
  },

  // A declined registration's one email (registration-approval.service.ts):
  // nothing about the event but its name. Returns whether it was sent; a
  // failure never undoes the decision.
  sendRegistrationDeclinedEmail: async (
    event: Parameters<typeof buildDispatchContext>[0],
    guestId: string,
    to: string
  ): Promise<{ ok: boolean }> => {
    const organiserEmail = await resolveReplyTo(event);
    const result = await sendEmail({
      to,
      ...buildRegistrationDeclinedEmail({ eventName: event.name, hostName: event.hostName, organiserEmail }),
    });
    if (!result.ok) {
      console.error(`[registration] declined email for guest ${guestId} failed: ${result.reason ?? 'unknown reason'}`);
      return { ok: false };
    }
    return { ok: true };
  },

  sendBulk: async (
    eventId: string,
    guestIds: string[],
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<SendInvitesResult> => {
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    // Status is checked first — before visibility, before guestIds is
    // even validated, and well before the guest list is loaded or the
    // SMS tier check runs. A draft event must fail fast on status, not
    // after doing work or telling the organiser about their SMS quota.
    assertEventIsPublished(event.status);
    assertEventAcceptsInvites(event.visibility);

    if (!guestIds?.length) {
      throw new HttpError(400, 'guestIds is required');
    }

    // Guest-ownership/eligibility pre-flight, before any tier check. A
    // selected guest who can't be sent to (removed, a plus-one, awaiting
    // approval, another of the organiser's events) is left out and named
    // in skippedGuests; everyone else goes. An id outside the caller's
    // reach refuses the WHOLE request, naming nobody
    // (invite-selection.util.ts).
    const selectedIds = [...new Set(guestIds)];
    const invites = await inviteRepository.findByGuestIds(eventId, selectedIds) as DispatchableInvite[];
    const foundGuestIds = new Set(invites.map((i) => i.guestId));
    const unsendable = await sortOutUnsendable(
      event,
      selectedIds.filter((id) => !foundGuestIds.has(id)),
      requestingRole,
      tenantId
    );

    // A text that can't go at all (sms off, a number that can't take one)
    // is a failure now, never queued, and costs nothing.
    const { email, sms, refused } = sortByChannel(invites);

    // Tier check — all-or-nothing, evaluated BEFORE anything is queued.
    // Also resolves WHICH pool (bundle vs quota) this whole batch draws
    // from — see sms-tier-enforcement.util.ts's header comment on why
    // that decision is made once per batch, never per guest.
    const { source: smsSource } = await assertSmsSendable(event, sms.length);

    // Emails and texts are queued together, under one send (the email daily
    // limit claimed in the same transaction, all or nothing) and sent by
    // the worker; a guest whose invitation is already on its way, or went
    // in the last few minutes, isn't queued again.
    const queued = await emailSendService.enqueue({
      eventId: event.id,
      kind: 'INVITATION',
      createdBy: userId,
      items: queueItems(email, sms, smsSource),
    });

    const failures = refused.map((r) => r.failure);
    const skippedGuests: SendSkip[] = [
      ...unsendable.map((g) => ({ ...g, sendId: null })),
      ...notQueuedGuests([...email, ...sms], queued),
    ];
    return {
      totalSelected: selectedIds.length,
      sendId: queued.sendId,
      queued: queued.queuedInviteIds.size,
      sent: 0,
      failed: failures.length,
      failures,
      skipped: skippedGuests.length,
      skippedGuests,
    };
  },

  resend: async (
    eventId: string,
    inviteId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<InviteDispatchOutcome> => {
    const invite = await inviteService.getById(eventId, inviteId, requestingRole, tenantId) as DispatchableInvite & {
      eventId: string;
    };
    // Must run AFTER getById above (tenant ownership already confirmed by
    // then) — never before, and never as a query-level swap on the fetch
    // itself: doing this check ahead of tenant verification would let a
    // cross-tenant probe distinguish "plus-one" (400) from "wrong tenant"
    // (404) for a record outside the caller's tenant, exactly the kind of
    // leak STEERING.md's tenant-scoping rule forbids.
    if (invite.guest.hostGuestId) {
      throw new HttpError(
        400,
        "This invitation belongs to a plus-one. Their host's RSVP covers them, so there's nothing to resend."
      );
    }
    const event = await eventService.getById(invite.eventId, requestingRole, tenantId);
    assertEventIsPublished(event.status);
    assertEventAcceptsInvites(event.visibility);

    const outcome = {
      guestId: invite.guestId,
      name: guestDisplayName(invite.guest),
      contact: contactFor(invite),
      deliveryMethod: invite.deliveryMethod,
    };

    // Queued like a bulk send (the same duplicate rules; the daily limit
    // for an email, the SMS quota or bundle for a text) and sent by the
    // worker, with the invite's EXISTING token — never regenerated, so a
    // guest who opens an old link days later doesn't find it dead.
    const { email, sms, refused } = sortByChannel([invite]);
    if (refused.length) {
      const { reason, code } = refused[0]!.failure;
      return { ...outcome, status: 'FAILED', sendId: null, reason, ...(code ? { code } : {}) };
    }
    // A resend still costs a real SMS — the tier rules for a batch of one.
    const smsSource: SmsSendPool = sms.length ? (await assertSmsSendable(event, 1)).source : 'QUOTA';
    const queued = await emailSendService.enqueue({
      eventId: event.id,
      kind: 'INVITATION',
      createdBy: userId,
      items: queueItems(email, sms, smsSource),
    });
    const notQueued = queued.notQueued.get(invite.id);
    return notQueued
      ? { ...outcome, status: notQueued.reason, sendId: notQueued.sendId, reason: NOT_QUEUED_MESSAGES[notQueued.reason] }
      : { ...outcome, status: 'QUEUED', sendId: queued.sendId };
  },

  // Manual "chase the non-responders" — the organiser presses the button;
  // there is deliberately no scheduler. An SMS reminder is counted and
  // gated exactly like an SMS invitation (assertSmsSendable: the same
  // never-pooled bundle/quota rule, the same all-or-nothing refusal); an
  // email reminder is queued and sent by the worker.
  //
  // guestIds omitted  -> every guest still waiting on a reminder.
  // guestIds given    -> only those guests (e.g. one table). A guest who
  //                      can't be reminded at all (removed, a plus-one,
  //                      awaiting approval, another event) and a guest whose
  //                      state rules them out (already responded, not yet
  //                      invited, reminded recently) are both SKIPPED and
  //                      reported, as bulk send does: a guest answering or
  //                      being removed between the organiser's screen and
  //                      their click is normal, not a malformed request. An
  //                      id outside the caller's reach refuses it whole.
  remindBulk: async (
    eventId: string,
    guestIds: string[] | undefined,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<SendRemindersResult> => {
    const event = await eventService.getById(eventId, requestingRole, tenantId);
    // Gates in the same order as sendBulk — status first, before any work.
    assertEventIsPublished(event.status, 'sending reminders');
    assertEventAcceptsInvites(event.visibility);
    assertRsvpDeadlineNotPassed(event.rsvpDeadline);

    const explicit = guestIds !== undefined;
    if (explicit && (!Array.isArray(guestIds) || !guestIds.length || guestIds.some((id) => typeof id !== 'string'))) {
      throw new HttpError(
        400,
        'guestIds must be a non-empty list of guest ids. Leave it out entirely to remind every guest who has not responded.'
      );
    }
    const selectedIds = explicit ? [...new Set(guestIds)] : undefined;

    const invites = await inviteRepository.findReminderCandidates(eventId, selectedIds) as (ReminderInvite & DispatchableInvite)[];
    // As sendBulk: a selected guest who can't be reminded at all (removed,
    // a plus-one, awaiting approval, another event) is skipped and named;
    // an id outside the caller's reach refuses the whole request.
    const foundGuestIds = new Set(invites.map((i) => i.guestId));
    const unsendable = selectedIds
      ? await sortOutUnsendable(event, selectedIds.filter((id) => !foundGuestIds.has(id)), requestingRole, tenantId)
      : [];

    // Per GUEST, never per invite — see classifyGuestForReminder.
    const byGuest = new Map<string, (ReminderInvite & DispatchableInvite)[]>();
    for (const invite of invites) {
      byGuest.set(invite.guestId, [...(byGuest.get(invite.guestId) ?? []), invite]);
    }

    const now = new Date();
    const toRemind: (ReminderInvite & DispatchableInvite)[] = [];
    const skippedGuests: ReminderSkip[] = [...unsendable];
    const skipReasons: ReminderSkipReason[] = [];
    // With no selection, people who have responded or were never invited
    // are simply not part of "everyone waiting on a reminder" — listing
    // hundreds of them as "skipped" would bury the answer. Someone the
    // organiser HAD picked, or who is waiting but held back (cooldown,
    // expired link), is always reported.
    const silentWhenUnselected: ReminderSkipReason[] = ['ALREADY_RESPONDED', 'NOT_INVITED_YET'];

    for (const group of byGuest.values()) {
      const verdict = classifyGuestForReminder(group, now);
      if ('remind' in verdict) {
        toRemind.push(verdict.remind as ReminderInvite & DispatchableInvite);
        continue;
      }
      if (!explicit && silentWhenUnselected.includes(verdict.skip)) continue;
      skipReasons.push(verdict.skip);
      skippedGuests.push({
        guestId: verdict.invite.guestId,
        name: guestDisplayName(verdict.invite.guest),
        contact: contactFor(verdict.invite),
        reason: verdict.skip,
        message: SKIP_MESSAGES[verdict.skip],
        ...(verdict.nextEligibleAt && { nextEligibleAt: verdict.nextEligibleAt.toISOString() }),
      });
    }

    // Every guest this request concerns, fixed BEFORE anyone moves from
    // toRemind to skipped — so queued + sent + failed + skipped is always
    // exactly this number.
    const totalSelected = toRemind.length + skippedGuests.length;

    if (!toRemind.length) {
      const why = [describeUnsendable(unsendable.map((g) => g.reason)), describeSkips(skipReasons)].filter(Boolean).join(', ');
      throw new HttpError(
        422,
        why
          ? `No one was reminded: ${why}. Reminders go only to guests who were sent an ` +
              `invitation and haven't responded yet.`
          : "There is no one to remind. Reminders go only to guests who were sent an invitation and haven't responded yet."
      );
    }

    // Texts that can't go at all (sms off, a number that can't take one)
    // are failures, never claimed or queued; written to the reminder log as
    // failed, as a failed text always was.
    const { refused } = sortByChannel(toRemind);
    const refusedIds = new Set(refused.map((r) => r.invite.id));
    const remindable = toRemind.filter((i) => !refusedIds.has(i.id));
    if (refused.length) {
      try {
        await inviteReminderLogRepository.createMany(
          refused.map(({ invite, failure }) => ({
            tenantId: event.tenantId,
            eventId: event.id,
            inviteId: invite.id,
            deliveryMethod: invite.deliveryMethod,
            succeeded: false,
            failureReason: failure.reason,
            sentBy: userId,
          }))
        );
      } catch (err) {
        console.error(`[reminders] could not write the reminder log rows for event ${event.id}:`, err);
      }
    }

    // Tier check — all-or-nothing, on the guests who would ACTUALLY be
    // texted (not those skipped or refused above), before anything is
    // queued. Same function invitations use, so the bundle and the monthly
    // quota can never pool here either.
    const { source: smsSource } = await assertSmsSendable(
      event,
      remindable.filter((i) => i.deliveryMethod !== 'EMAIL').length,
      'reminder'
    );

    // Claimed together, in one conditional write: only invites still
    // pending and outside the cooldown are claimed. One that changed since
    // it was classified (answered, or reminded by an overlapping request) is
    // skipped and reported, as before. The cooldown starts when a reminder
    // is queued, so a second press of Remind finds it held.
    const claimedAt = new Date();
    const claimedIds = await inviteRepository.claimReminders(
      remindable.map((i) => i.id),
      new Date(claimedAt.getTime() - REMINDER_COOLDOWN_MS),
      claimedAt
    );
    const claimed = remindable.filter((i) => claimedIds.has(i.id));
    const stateChanged = (invite: DispatchableInvite) => {
      skipReasons.push('STATE_CHANGED');
      skippedGuests.push({
        guestId: invite.guestId,
        name: guestDisplayName(invite.guest),
        contact: contactFor(invite),
        reason: 'STATE_CHANGED',
        message: SKIP_MESSAGES.STATE_CHANGED,
      });
    };
    for (const invite of remindable.filter((i) => !claimedIds.has(i.id))) stateChanged(invite);

    // Emails and texts: queued together with the cooldown each claimed (the
    // worker gives it back if the reminder doesn't go), the email daily
    // limit claimed in the same transaction. Refused, nobody is reminded
    // and every cooldown just claimed is given back; one the queue already
    // holds is given back too.
    const toItem = (i: (typeof claimed)[number]) => ({ inviteId: i.id, remindedAt: claimedAt, previousRemindedAt: i.lastRemindedAt });
    let queued: EnqueueResult;
    try {
      queued = await emailSendService.enqueue({
        eventId: event.id,
        kind: 'REMINDER',
        createdBy: userId,
        items: claimed.map((i) =>
          i.deliveryMethod === 'EMAIL' ? { ...toItem(i), channel: 'EMAIL' as const } : { ...toItem(i), channel: 'SMS' as const, smsSource }
        ),
      });
    } catch (err) {
      await inviteRepository.releaseReminderClaims(claimed.map((i) => ({ id: i.id, previous: i.lastRemindedAt })), claimedAt);
      throw err;
    }
    const notQueued = claimed.filter((i) => !queued.queuedInviteIds.has(i.id));
    await inviteRepository.releaseReminderClaims(notQueued.map((i) => ({ id: i.id, previous: i.lastRemindedAt })), claimedAt);
    for (const invite of notQueued) stateChanged(invite);

    const failures = refused.map((r) => r.failure);
    return {
      totalSelected,
      sendId: queued.sendId,
      queued: queued.queuedInviteIds.size,
      sent: 0,
      failed: failures.length,
      skipped: skippedGuests.length,
      skippedRecentlyReminded: skipReasons.filter((r) => r === 'RECENTLY_REMINDED').length,
      cooldownHours: REMINDER_COOLDOWN_HOURS,
      failures,
      skippedGuests,
    };
  },
};

// The rendering the worker uses (email-send.worker.ts): the same context
// and builders for an email and a text.
export const inviteEmailRendering = { buildDispatchContext, buildEmailFor, buildSmsFor };
