import { type PlatformRole, type DeliveryMethod } from '@prisma/client';
import { inviteRepository } from './invite.repository.js';
import { inviteService } from './invite.service.js';
import { eventService } from '../event/event.service.js';
import { assertSmsSendable, type SmsSendPool } from '../subscription-tier-config/sms-tier-enforcement.util.js';
import { smsSendLogRepository } from '../sms-send-log/sms-send-log.repository.js';
import { inviteReminderLogRepository } from '../invite-reminder-log/invite-reminder-log.repository.js';
import { sendSms } from '../../shared/messaging/sms.engine.js';
import { sendEmail } from '../../shared/messaging/email.engine.js';
import {
  buildInviteRsvpLink,
  buildInviteEmail,
  buildInviteSmsBody,
  buildReminderEmail,
  buildReminderSmsBody,
  buildRegistrationEmail,
  buildRegistrationResendEmail,
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

// Bulk invite orchestrator — knows guests/invites/tiers and routes each
// guest to whichever engine matches their contact. Kept separate from
// invite.service.ts (which stays pure CRUD) since dispatch has its own
// dependency set: engines, tier enforcement, message builders, sms log.
// Never touches the Twilio/Resend SDKs directly — only sendSms/sendEmail.
//
// Reminders (remindBulk) go through this SAME dispatchOne — one dispatch
// path, one place a message reaches an engine and an SMS is counted. The
// only differences between an invitation and a reminder are the words, and
// that a reminder must not touch Invite.deliveredAt.

export interface InviteDispatchFailure {
  guestId: string;
  name: string;
  contact: string;
  reason: string;
}

export interface SendInvitesResult {
  totalSelected: number;
  sent: number;
  failed: number;
  failures: InviteDispatchFailure[];
}

export interface InviteDispatchOutcome {
  guestId: string;
  name: string;
  contact: string;
  deliveryMethod: DeliveryMethod;
  ok: boolean;
  reason?: string;
}

export interface ReminderSkip {
  guestId: string;
  name: string;
  contact: string;
  reason: ReminderSkipReason;
  message: string;
  // Only for RECENTLY_REMINDED — when they can next be reminded.
  nextEligibleAt?: string;
}

export interface SendRemindersResult {
  // Guests this request concerned. sent + failed + skipped always equals it.
  totalSelected: number;
  sent: number;
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
      "Public events don't use invites — share the event's public link instead (GET /api/events/:eventId/share-link)."
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

// How many SMS a batch would send, for the tier check. Zero while sms is
// off: nothing will be texted, so there is no quota to check and no plan
// message about SMS to show.
const smsCountFor = (invites: { deliveryMethod: DeliveryMethod }[]): number =>
  isFeatureEnabled('sms') ? invites.filter((i) => i.deliveryMethod === 'SMS').length : 0;

interface DispatchContext {
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

const buildMessage = (kind: DispatchKind, ctx: DispatchContext, days: InviteDayLine[], rsvpLink: string) => {
  const input = {
    eventName: ctx.eventName,
    hostName: ctx.hostName,
    days,
    fallbackDateLabel: ctx.dateLabel,
    rsvpDeadline: ctx.rsvpDeadline,
    rsvpLink,
    design: ctx.design,
    organiserEmail: ctx.organiserEmail,
  };
  return kind === 'INVITE'
    ? { email: buildInviteEmail(input), smsBody: buildInviteSmsBody(ctx.eventName, rsvpLink) }
    : { email: buildReminderEmail(input), smsBody: buildReminderSmsBody(ctx.eventName, rsvpLink, ctx.rsvpDeadline) };
};

const dispatchOne = async (
  ctx: DispatchContext,
  invite: DispatchableInvite,
  // Which of the two never-pooled SMS accounting systems this batch was
  // already resolved (once, by assertSmsSendable) to draw from — passed
  // through rather than re-derived per guest, so the log can never
  // disagree with what was actually enforced. Meaningless for an EMAIL
  // delivery.
  smsSource: SmsSendPool,
  kind: DispatchKind = 'INVITE'
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  if (invite.deliveryMethod === 'SMS' && !isFeatureEnabled('sms')) {
    return { ok: false, reason: SMS_UNAVAILABLE_REASON };
  }
  const message = buildMessage(kind, ctx, invitedDaysFor(invite), buildInviteRsvpLink(invite.token));

  const result = invite.deliveryMethod === 'EMAIL'
    ? await sendEmail({ to: invite.guest.email ?? '', ...message.email })
    : await sendSms(invite.guest.phoneNumber ?? '', message.smsBody);

  if (!result.ok) return { ok: false, reason: result.reason ?? 'Delivery failed' };

  // Only marked delivered on real dispatch success — a resend remains
  // possible for anything that fails here, since deliveredAt stays null.
  // A REMINDER never touches it: deliveredAt is "when the invitation
  // reached them", which is what makes a guest reminder-eligible.
  if (kind === 'INVITE') await inviteRepository.markDelivered(invite.id);
  if (invite.deliveryMethod === 'SMS') {
    await smsSendLogRepository.create(ctx.tenantId, ctx.eventId, invite.id, smsSource);
  }
  return { ok: true };
};

export const inviteDispatchService = {
  // Public self-registration (event-public.service.ts): emails one guest
  // their own link, right after they register or when the same email
  // registers again. Not a bulk send and never an SMS (registration
  // requires an email), but built from the same dispatch context as an
  // invitation, so the From, Reply-To and design image are the same.
  // `kind` is REGISTRATION for a guest who registered themselves, INVITE
  // for one the organiser added (their own email is the invitation).
  // Marks the invite delivered the first time a send succeeds, exactly as
  // dispatchOne does, so the guest counts as invited everywhere else.
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

  sendBulk: async (
    eventId: string,
    guestIds: string[],
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

    // Guest-ownership/eligibility pre-flight — wrong event, archived
    // guest, or archived invite all land here, and reject the WHOLE
    // request (nobody in the batch is dispatched), before any tier check.
    const invites = await inviteRepository.findByGuestIds(eventId, guestIds) as DispatchableInvite[];
    const foundGuestIds = new Set(invites.map((i) => i.guestId));
    const missing = guestIds.filter((id) => !foundGuestIds.has(id));
    if (missing.length) {
      throw new HttpError(
        400,
        `${missing.length} guest(s) are not eligible for sending — they may be archived, have an ` +
          `archived invite, belong to a different event, or be a plus-one (who has no invitation of ` +
          `their own): ${missing.join(', ')}`
      );
    }

    // Tier check — all-or-nothing, evaluated BEFORE any dispatch begins.
    // Also resolves WHICH pool (bundle vs quota) this whole batch draws
    // from — see sms-tier-enforcement.util.ts's header comment on why
    // that decision is made once per batch, never per guest.
    const { source: smsSource } = await assertSmsSendable(event, smsCountFor(invites));

    const ctx = await buildDispatchContext(event);
    const failures: InviteDispatchFailure[] = [];
    let sent = 0;

    // Sequential, not Promise.all — avoids bursting Twilio/Resend rate
    // limits and keeps SmsSendLog writes ordered per tenant. Partial
    // failure is expected and fine here (a different category from the
    // pre-flight rejects above): one bad phone number must not abort the
    // rest of the batch.
    for (const invite of invites) {
      const result = await dispatchOne(ctx, invite, smsSource);
      if (result.ok) {
        sent += 1;
      } else {
        failures.push({
          guestId: invite.guestId,
          name: guestDisplayName(invite.guest),
          contact: contactFor(invite),
          reason: result.reason,
        });
      }
    }

    return { totalSelected: guestIds.length, sent, failed: failures.length, failures };
  },

  resend: async (
    inviteId: string,
    requestingRole: PlatformRole,
    tenantId: string | null
  ): Promise<InviteDispatchOutcome> => {
    const invite = await inviteService.getById(inviteId, requestingRole, tenantId) as DispatchableInvite & {
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
        "This invitation belongs to a plus-one — they're covered by their host's RSVP and have no invitation of their own to resend."
      );
    }
    const event = await eventService.getById(invite.eventId, requestingRole, tenantId);
    assertEventIsPublished(event.status);
    assertEventAcceptsInvites(event.visibility);

    // A resend still costs a real SMS — re-check the tier rules for a
    // batch-of-one before dispatching. EMAIL never touches either SMS
    // pool, so `smsSource` is meaningless (and unused) in that branch —
    // 'QUOTA' is just a harmless placeholder, never written anywhere.
    const smsSource: SmsSendPool =
      smsCountFor([invite]) ? (await assertSmsSendable(event, 1)).source : 'QUOTA';

    const ctx = await buildDispatchContext(event);
    // Dispatches using the invite's EXISTING token — never regenerated,
    // so a guest who opens an old link days later doesn't find it dead.
    const result = await dispatchOne(ctx, invite, smsSource);

    return {
      guestId: invite.guestId,
      name: guestDisplayName(invite.guest),
      contact: contactFor(invite),
      deliveryMethod: invite.deliveryMethod,
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason }),
    };
  },

  // Manual "chase the non-responders" — the organiser presses the button;
  // there is deliberately no scheduler. Reuses dispatchOne and
  // assertSmsSendable, so an SMS reminder is counted and gated exactly
  // like an SMS invitation: the same never-pooled bundle/quota rule, the
  // same all-or-nothing refusal.
  //
  // guestIds omitted  -> every guest still waiting on a reminder.
  // guestIds given    -> only those guests (e.g. one table). Structural
  //                      problems reject the whole request, as bulk send
  //                      does; state-based ones (already responded, not yet
  //                      invited, reminded recently) are SKIPPED and
  //                      reported, because a guest answering between the
  //                      organiser's screen and their click is normal, not
  //                      a malformed request.
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
    if (selectedIds) {
      const foundGuestIds = new Set(invites.map((i) => i.guestId));
      const missing = selectedIds.filter((id) => !foundGuestIds.has(id));
      if (missing.length) {
        throw new HttpError(
          400,
          `${missing.length} guest(s) are not eligible for a reminder — they may be archived, have an ` +
            `archived invite, belong to a different event, or be a plus-one (who has no contact of ` +
            `their own): ${missing.join(', ')}`
        );
      }
    }

    // Per GUEST, never per invite — see classifyGuestForReminder.
    const byGuest = new Map<string, (ReminderInvite & DispatchableInvite)[]>();
    for (const invite of invites) {
      byGuest.set(invite.guestId, [...(byGuest.get(invite.guestId) ?? []), invite]);
    }

    const now = new Date();
    const toRemind: (ReminderInvite & DispatchableInvite)[] = [];
    const skippedGuests: ReminderSkip[] = [];
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

    // Every guest this request concerns, fixed BEFORE the send loop moves
    // anyone from toRemind to skipped — so sent + failed + skipped is
    // always exactly this number.
    const totalSelected = toRemind.length + skippedGuests.length;

    if (!toRemind.length) {
      throw new HttpError(
        422,
        skipReasons.length
          ? `No one was reminded: ${describeSkips(skipReasons)}. Reminders go only to guests who were sent an ` +
              `invitation and haven't responded yet.`
          : "There is no one to remind. Reminders go only to guests who were sent an invitation and haven't responded yet."
      );
    }

    // Tier check — all-or-nothing, on the guests who would ACTUALLY be
    // texted (not those skipped above), before any dispatch begins. Same
    // function invitations use, so the bundle and the monthly quota can
    // never pool here either.
    const { source: smsSource } = await assertSmsSendable(event, smsCountFor(toRemind), 'reminder');

    const ctx = await buildDispatchContext(event);
    const failures: InviteDispatchFailure[] = [];
    let sent = 0;

    // Sequential, for the same reasons as sendBulk.
    for (const invite of toRemind) {
      const claimedAt = new Date();
      const claimed = await inviteRepository.claimReminder(
        invite.id,
        new Date(claimedAt.getTime() - REMINDER_COOLDOWN_MS),
        claimedAt
      );
      if (!claimed) {
        skipReasons.push('STATE_CHANGED');
        skippedGuests.push({
          guestId: invite.guestId,
          name: guestDisplayName(invite.guest),
          contact: contactFor(invite),
          reason: 'STATE_CHANGED',
          message: SKIP_MESSAGES.STATE_CHANGED,
        });
        continue;
      }

      let result: { ok: true } | { ok: false; reason: string };
      try {
        result = await dispatchOne(ctx, invite, smsSource, 'REMINDER');
      } catch (err) {
        await inviteRepository.releaseReminderClaim(invite.id, claimedAt, invite.lastRemindedAt);
        throw err;
      }
      // A failed send must not start the cooldown: they never got it.
      if (!result.ok) await inviteRepository.releaseReminderClaim(invite.id, claimedAt, invite.lastRemindedAt);

      // The audit row must never abort a batch that has already texted
      // people — losing the per-guest result mid-way is worse than a
      // missing log row, which is reported loudly instead.
      try {
        await inviteReminderLogRepository.create({
          tenantId: event.tenantId,
          eventId: event.id,
          inviteId: invite.id,
          deliveryMethod: invite.deliveryMethod,
          succeeded: result.ok,
          failureReason: result.ok ? null : result.reason,
          sentBy: userId,
        });
      } catch (err) {
        console.error(`[reminders] could not write the reminder log row for invite ${invite.id}:`, err);
      }

      if (result.ok) {
        sent += 1;
      } else {
        failures.push({
          guestId: invite.guestId,
          name: guestDisplayName(invite.guest),
          contact: contactFor(invite),
          reason: result.reason,
        });
      }
    }

    return {
      totalSelected,
      sent,
      failed: failures.length,
      skipped: skippedGuests.length,
      skippedRecentlyReminded: skipReasons.filter((r) => r === 'RECENTLY_REMINDED').length,
      cooldownHours: REMINDER_COOLDOWN_HOURS,
      failures,
      skippedGuests,
    };
  },
};
