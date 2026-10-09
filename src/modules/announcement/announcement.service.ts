import { type AnnouncementAudience, type PlatformRole } from '@prisma/client';
import { eventService } from '../event/event.service.js';
import { inviteDispatchService, type GuestMessageOutcome, type GuestMessageRecipient } from '../invite/invite-dispatch.service.js';
import {
  buildAnnouncementEmail,
  buildCancellationEmail,
  buildCancellationEmailSubject,
  buildInviteRsvpLink,
} from '../invite/invite-message.util.js';
import { sanitizeHeaderText } from '../../shared/messaging/email-address.util.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { formatGuestDate, formatGuestTime } from '../../shared/utils/guest-date.util.js';
import { announcementRepository } from './announcement.repository.js';
import {
  ANNOUNCEMENT_AUDIENCES,
  selectAudience,
  toAudienceCandidates,
  type AudienceSelection,
} from './announcement-audience.util.js';
import {
  type AnnouncementAudienceDto,
  type AnnouncementDeliveryReport,
  type AnnouncementPreview,
  type AnnouncementView,
  type CancelEventDto,
  type SendAnnouncementDto,
} from './announcement.types.js';

// ─────────────────────────────────────────
//  ANNOUNCEMENTS
//
//  An organiser's email to their guests ("Buses leave at 18:00"), and the
//  automatic one sent when the event is cancelled. Behind the
//  `announcements` flag (the router; cancelEvent checks it itself, since
//  cancelling is not part of the feature).
//
//  Every call gates on eventService.getScoped first: tenant scoping and
//  the assignment lock, so another tenant's event and a locked member's
//  unassigned event are the same 404. Who receives it is
//  announcement-audience.util.ts. Sending is inviteDispatchService
//  .sendGuestMessages: the invitation's From and Reply-To, email only.
//
//  The history is append-only: an Announcement is written when the send
//  is claimed (under the event's row lock, which is what makes the daily
//  limit hold when two sends race), and one AnnouncementDelivery per guest
//  once their email has gone or failed. Nothing is updated afterwards.
// ─────────────────────────────────────────

// At most this many organiser announcements per event in any 24 hours
// (the cancellation email is never counted or refused). A real event
// needs a handful on its busiest day: the week-before logistics, a
// day-of change, a "running late", a thank-you. Beyond that, guests start
// treating the sender as noise, and the sender is e-velope's own address,
// which every tenant's invitations share: one organiser flooding inboxes
// costs everyone's deliverability. Rolling 24 hours, not a calendar day:
// events have no timezone to say whose midnight it is, and a calendar day
// would allow ten in a row either side of it.
export const ANNOUNCEMENTS_PER_EVENT_PER_DAY = 5;
const ANNOUNCEMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const MAX_ANNOUNCEMENT_SUBJECT_LENGTH = 150;
export const MAX_ANNOUNCEMENT_BODY_LENGTH = 5000;
export const MAX_CANCELLATION_NOTE_LENGTH = 1000;

// One per refusal, so the form marks the field it belongs to; the daily
// limit's 429 has one too. A wrong type (400), the cancelled event (409)
// and the 404s have none.
export const ANNOUNCEMENT_ERROR_CODES = {
  SUBJECT_REQUIRED: 'ANNOUNCEMENT_SUBJECT_REQUIRED',
  SUBJECT_TOO_LONG: 'ANNOUNCEMENT_SUBJECT_TOO_LONG',
  BODY_REQUIRED: 'ANNOUNCEMENT_BODY_REQUIRED',
  BODY_TOO_LONG: 'ANNOUNCEMENT_BODY_TOO_LONG',
  AUDIENCE_INVALID: 'ANNOUNCEMENT_AUDIENCE_INVALID',
  DAY_INVALID: 'ANNOUNCEMENT_DAY_INVALID',
  NO_RECIPIENTS: 'ANNOUNCEMENT_NO_RECIPIENTS',
  DAILY_LIMIT: 'ANNOUNCEMENT_DAILY_LIMIT',
  NOTE_TOO_LONG: 'CANCELLATION_NOTE_TOO_LONG',
} as const;

const CODES = ANNOUNCEMENT_ERROR_CODES;

type ScopedEvent = Awaited<ReturnType<typeof eventService.getScoped>>;

const CANCELLED_MESSAGE = "This event has been cancelled, so announcements can't be sent.";

const assertNotCancelled = (status: string): void => {
  if (status === 'CANCELLED') throw new HttpError(409, CANCELLED_MESSAGE);
};

const parseAudience = (data: AnnouncementAudienceDto, event: ScopedEvent): { audience: AnnouncementAudience; eventDayId: string | null } => {
  if (data.audience === undefined || data.audience === null || data.audience === '') {
    throw new HttpError(422, 'Choose who should receive this announcement.', CODES.AUDIENCE_INVALID);
  }
  if (typeof data.audience !== 'string') {
    throw new HttpError(400, `audience must be one of ${ANNOUNCEMENT_AUDIENCES.join(', ')}.`);
  }
  if (!(ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(data.audience)) {
    throw new HttpError(
      422,
      `'${data.audience}' isn't an audience. Choose one of ${ANNOUNCEMENT_AUDIENCES.join(', ')}.`,
      CODES.AUDIENCE_INVALID
    );
  }

  if (data.eventDayId === undefined || data.eventDayId === null || data.eventDayId === '') {
    return { audience: data.audience as AnnouncementAudience, eventDayId: null };
  }
  if (typeof data.eventDayId !== 'string') throw new HttpError(400, 'eventDayId must be a day id, or left out for every day.');
  // Live days only (getScoped loads no archived ones).
  if (!event.eventDays.some((d) => d.id === data.eventDayId)) {
    throw new HttpError(422, "That day isn't part of this event. Please refresh the page and choose again.", CODES.DAY_INVALID);
  }
  return { audience: data.audience as AnnouncementAudience, eventDayId: data.eventDayId };
};

// Plain text. The subject goes into a header, so it is made header-safe
// (no line breaks or control characters) before its length is judged, and
// stored that way: the history shows exactly what was sent.
const parseContent = (data: SendAnnouncementDto): { subject: string; body: string } => {
  if (data.subject !== undefined && data.subject !== null && typeof data.subject !== 'string') {
    throw new HttpError(400, 'subject must be text.');
  }
  if (data.body !== undefined && data.body !== null && typeof data.body !== 'string') {
    throw new HttpError(400, 'body must be text.');
  }

  const subject = sanitizeHeaderText((data.subject as string | null | undefined) ?? '');
  if (!subject) throw new HttpError(422, 'Give your announcement a subject.', CODES.SUBJECT_REQUIRED);
  if (subject.length > MAX_ANNOUNCEMENT_SUBJECT_LENGTH) {
    throw new HttpError(
      422,
      `The subject can be at most ${MAX_ANNOUNCEMENT_SUBJECT_LENGTH} characters (it's ${subject.length}).`,
      CODES.SUBJECT_TOO_LONG
    );
  }

  const body = ((data.body as string | null | undefined) ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new HttpError(422, 'Write the message your guests will receive.', CODES.BODY_REQUIRED);
  if (body.length > MAX_ANNOUNCEMENT_BODY_LENGTH) {
    throw new HttpError(
      422,
      `The message can be at most ${MAX_ANNOUNCEMENT_BODY_LENGTH} characters (it's ${body.length}).`,
      CODES.BODY_TOO_LONG
    );
  }
  return { subject, body };
};

const parseNote = (data: CancelEventDto | undefined): string | null => {
  const note = data?.note;
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') throw new HttpError(400, 'note must be text.');
  const clean = note.replace(/\r\n?/g, '\n').trim();
  if (clean.length > MAX_CANCELLATION_NOTE_LENGTH) {
    throw new HttpError(
      422,
      `The note to your guests can be at most ${MAX_CANCELLATION_NOTE_LENGTH} characters (it's ${clean.length}).`,
      CODES.NOTE_TOO_LONG
    );
  }
  return clean || null;
};

const resolveAudience = async (eventId: string, audience: AnnouncementAudience, eventDayId: string | null): Promise<AudienceSelection> =>
  selectAudience(toAudienceCandidates(await announcementRepository.findAudienceGuests(eventId)), audience, eventDayId);

const toView = (
  row: {
    id: string;
    kind: AnnouncementView['kind'];
    subject: string;
    body: string | null;
    audience: AnnouncementAudience;
    eventDayId: string | null;
    sentBy: string;
    sentAt: Date;
    recipientCount: number;
    unreachableCount: number;
  },
  eventDayLabel: string | null,
  failureCount: number
): AnnouncementView => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  body: row.body,
  audience: row.audience,
  eventDayId: row.eventDayId,
  eventDayLabel,
  sentBy: row.sentBy,
  sentAt: row.sentAt.toISOString(),
  recipientCount: row.recipientCount,
  failureCount,
  unreachableCount: row.unreachableCount,
});

const dailyLimitRefusal = (oldestInWindow: Date): HttpError => {
  const next = new Date(oldestInWindow.getTime() + ANNOUNCEMENT_WINDOW_MS);
  return new HttpError(
    429,
    `You've sent ${ANNOUNCEMENTS_PER_EVENT_PER_DAY} announcements for this event in the last 24 hours, the most ` +
      `allowed. You can send the next one from ${formatGuestTime(next)} UTC on ${formatGuestDate(next)}.`,
    CODES.DAILY_LIMIT
  );
};

// Sends to the selection's reachable guests and writes one delivery row
// each. The row writes must never turn a send that already reached guests
// into an error: a failure there is logged loudly instead, as for the
// reminder log.
const deliver = async (
  event: { tenantId: string; createdByUserId: string },
  announcementId: string,
  selection: AudienceSelection,
  build: Parameters<typeof inviteDispatchService.sendGuestMessages>[2]
): Promise<GuestMessageOutcome[]> => {
  const recipients: GuestMessageRecipient[] = selection.reachable;
  const outcomes = await inviteDispatchService.sendGuestMessages(event, recipients, build);
  try {
    await announcementRepository.createDeliveries(
      outcomes.map((o) => ({ announcementId, guestId: o.guestId, succeeded: o.ok, failureReason: o.ok ? null : (o.reason ?? null) }))
    );
  } catch (err) {
    console.error(`[announcements] could not write the delivery rows for announcement ${announcementId}:`, err);
  }
  return outcomes;
};

const report = (
  view: AnnouncementView | null,
  outcomes: GuestMessageOutcome[],
  selection: AudienceSelection
): AnnouncementDeliveryReport => {
  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ guestId: o.guestId, name: o.name, email: o.email, reason: o.reason ?? 'Delivery failed' }));
  return {
    announcement: view,
    sent: outcomes.length - failures.length,
    failed: failures.length,
    failures,
    unreachableCount: selection.unreachable.length,
    unreachable: selection.unreachable,
  };
};

// The automatic email on cancel: every invited guest who hasn't declined,
// no day filter, no limit. Recorded like any announcement, unless nobody
// was in the audience at all (a draft's guests were never invited).
const notifyCancellation = async (
  event: ScopedEvent,
  userId: string,
  note: string | null
): Promise<AnnouncementDeliveryReport> => {
  const selection = await resolveAudience(event.id, 'EVERYONE', null);
  if (!selection.reachable.length && !selection.unreachable.length) return report(null, [], selection);

  const subject = buildCancellationEmailSubject(event.name);
  const row = await announcementRepository.create({
    eventId: event.id,
    kind: 'CANCELLATION',
    subject,
    body: note,
    audience: 'EVERYONE',
    eventDayId: null,
    sentBy: userId,
    recipientCount: selection.reachable.length,
    unreachableCount: selection.unreachable.length,
  });

  const days = [...event.eventDays].sort((a, b) => a.date.getTime() - b.date.getTime());
  const outcomes = await deliver(event, row.id, selection, (recipient, organiserEmail) =>
    buildCancellationEmail({
      eventName: event.name,
      hostName: event.hostName,
      organiserEmail,
      selfRegistered: recipient.selfRegistered,
      days,
      note,
    })
  );
  return report(toView(row, null, outcomes.filter((o) => !o.ok).length), outcomes, selection);
};

export const announcementService = {
  preview: async (
    eventId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: AnnouncementAudienceDto = {}
  ): Promise<AnnouncementPreview> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertNotCancelled(event.status);
    const { audience, eventDayId } = parseAudience(data, event);
    const selection = await resolveAudience(event.id, audience, eventDayId);
    return {
      audience,
      eventDayId,
      recipientCount: selection.reachable.length,
      unreachableCount: selection.unreachable.length,
      unreachable: selection.unreachable,
    };
  },

  send: async (
    eventId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: SendAnnouncementDto = {}
  ): Promise<AnnouncementDeliveryReport> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    assertNotCancelled(event.status);
    const { subject, body } = parseContent(data);
    const { audience, eventDayId } = parseAudience(data, event);

    const selection = await resolveAudience(event.id, audience, eventDayId);
    if (!selection.reachable.length) {
      throw new HttpError(
        422,
        selection.unreachable.length
          ? `None of the ${selection.unreachable.length} guest(s) in this audience has an email address, so nobody would receive it.`
          : 'No guests match this audience yet. Announcements go to guests who have received their invitation or registered.',
        CODES.NO_RECIPIENTS
      );
    }

    // Claimed under the event's row lock: counted and written with no other
    // claim for this event committing in between. A refused claim writes
    // nothing and sends nothing.
    const row = await announcementRepository.withEventAnnouncementLock(event.id, async (tx, status) => {
      assertNotCancelled(status);
      const recent = await announcementRepository.findSentSince(event.id, new Date(Date.now() - ANNOUNCEMENT_WINDOW_MS), tx);
      if (recent.length >= ANNOUNCEMENTS_PER_EVENT_PER_DAY) throw dailyLimitRefusal(recent[0]!.sentAt);
      return announcementRepository.create(
        {
          eventId: event.id,
          kind: 'ANNOUNCEMENT',
          subject,
          body,
          audience,
          eventDayId,
          sentBy: userId,
          recipientCount: selection.reachable.length,
          unreachableCount: selection.unreachable.length,
        },
        tx
      );
    });

    const outcomes = await deliver(event, row.id, selection, (recipient, organiserEmail) =>
      buildAnnouncementEmail({
        eventName: event.name,
        hostName: event.hostName,
        organiserEmail,
        selfRegistered: recipient.selfRegistered,
        subject,
        body,
        rsvpLink: buildInviteRsvpLink(recipient.inviteToken),
      })
    );

    const dayLabel = eventDayId ? (event.eventDays.find((d) => d.id === eventDayId)?.label ?? null) : null;
    return report(toView(row, dayLabel, outcomes.filter((o) => !o.ok).length), outcomes, selection);
  },

  // Newest first. Cancelled events keep their history (the cancellation
  // email is in it).
  list: async (eventId: string, requestingRole: PlatformRole, tenantId: string | null): Promise<AnnouncementView[]> => {
    const event = await eventService.getScoped(eventId, requestingRole, tenantId);
    const rows = await announcementRepository.findAllForEvent(event.id);
    return rows.map((r) => toView(r, r.eventDay?.label ?? null, r._count.deliveries));
  },

  // POST /api/events/:id/cancel. The note is checked BEFORE the event is
  // cancelled (a too-long note cancels nothing); the cancel itself is
  // eventService.cancel. Then every invited guest who hasn't declined is
  // emailed. Cancelling never fails because an email did: the failures are
  // in the response, beside the cancelled event. With `announcements` off,
  // nobody is emailed and guestNotification is null.
  cancelEvent: async (
    eventId: string,
    userId: string,
    requestingRole: PlatformRole,
    tenantId: string | null,
    data: CancelEventDto | undefined
  ) => {
    const note = parseNote(data);
    const cancelled = await eventService.cancel(eventId, userId, requestingRole, tenantId);
    if (!isFeatureEnabled('announcements')) return { ...cancelled, guestNotification: null };

    let guestNotification: AnnouncementDeliveryReport;
    try {
      guestNotification = await notifyCancellation(cancelled, userId, note);
    } catch (err) {
      // The event IS cancelled; an answer of 500 would say it wasn't.
      console.error(`[announcements] cancellation email for event ${eventId} failed:`, err);
      guestNotification = {
        ...report(null, [], { reachable: [], unreachable: [] }),
        error: "Your event is cancelled, but we couldn't email your guests about it. Send them an announcement from the event page instead.",
      };
    }
    return { ...cancelled, guestNotification };
  },
};
