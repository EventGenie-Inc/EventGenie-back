import { type DeliveryMethod, type InviteStatus } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';

// ─────────────────────────────────────────
//  REMINDER RULES
//
//  Pure functions — no database, no engines — so the rules that decide who
//  is chased, and when, can be read (and tested) on their own. The
//  orchestration that acts on them is invite-dispatch.service.ts's
//  remindBulk.
// ─────────────────────────────────────────

// The minimum gap between two reminders to the same guest, rolling (not
// "once per calendar day" — that would let a 23:59 and a 00:01 through).
// One day: long enough that an accidental double-click, or two organisers
// chasing at once, can never text a guest twice; short enough not to stand
// in the way of a genuine "final call" the day before the deadline. It is
// a floor, not a recommended cadence. A constant, not a setting — see the
// task report for the argument, and why it isn't per-tenant.
export const REMINDER_COOLDOWN_HOURS = 24;
export const REMINDER_COOLDOWN_MS = REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000;

export type ReminderSkipReason =
  | 'ALREADY_RESPONDED'
  | 'NOT_INVITED_YET'
  | 'INVITE_EXPIRED'
  | 'RECENTLY_REMINDED'
  | 'STATE_CHANGED';

// The slice of an invite (with its guest) the rules need. Structural, so
// the Prisma row satisfies it without an import cycle into the repository.
export interface ReminderInvite {
  id: string;
  guestId: string;
  status: InviteStatus;
  deliveryMethod: DeliveryMethod;
  deliveredAt: Date | null;
  expiresAt: Date | null;
  lastRemindedAt: Date | null;
  guest: { firstName: string | null; surname: string | null; email: string | null; phoneNumber: string | null };
}

export type ReminderVerdict =
  | { remind: ReminderInvite }
  | { skip: ReminderSkipReason; invite: ReminderInvite; nextEligibleAt?: Date };

// Decides what happens to ONE guest, given all of their live invites for
// the event (usually one; more is possible — an organiser can add a second
// invite, and public re-registration hands back the latest — so the rules
// are stated per guest, never per invite, or a guest could be chased twice
// or chased after answering through a different invite).
export const classifyGuestForReminder = (invites: ReminderInvite[], now: Date): ReminderVerdict => {
  // Answered = ANY live invite is ACCEPTED or DECLINED. Chasing them is
  // worse than not chasing at all.
  const answered = invites.find((i) => i.status !== 'PENDING');
  if (answered) return { skip: 'ALREADY_RESPONDED', invite: answered };

  // "Sent" means Invite.deliveredAt — set only on a genuinely successful
  // dispatch (invite-dispatch.service.ts's dispatchOne). A guest whose
  // invitation was never delivered needs an invitation, not a reminder.
  const delivered = invites.filter((i) => i.deliveredAt !== null);
  if (!delivered.length) return { skip: 'NOT_INVITED_YET', invite: invites[0]! };

  // The invite that most recently reached them — its link is the one they
  // hold, so it is the one a reminder should carry.
  const target = delivered.reduce((a, b) => (a.deliveredAt! >= b.deliveredAt! ? a : b));

  // A reminder linking to an expired invitation sends them to a page that
  // refuses them (rsvp.service.ts answers 410). They need a new invitation.
  if (target.expiresAt && target.expiresAt < now) return { skip: 'INVITE_EXPIRED', invite: target };

  const lastReminded = invites.reduce<Date | null>(
    (latest, i) => (i.lastRemindedAt && (!latest || i.lastRemindedAt > latest) ? i.lastRemindedAt : latest),
    null
  );
  if (lastReminded) {
    const nextEligibleAt = new Date(lastReminded.getTime() + REMINDER_COOLDOWN_MS);
    if (nextEligibleAt > now) return { skip: 'RECENTLY_REMINDED', invite: target, nextEligibleAt };
  }

  return { remind: target };
};

// Reminding after the RSVP deadline tells guests to respond by a date that
// has gone — and the RSVP page would refuse them anyway (410). Same strict
// comparison as rsvp.service.ts's isRsvpDeadlinePassed, so "the reminder
// refuses" and "the guest is refused" flip at exactly the same instant.
// 409 like the other event-state gates; the organiser CAN fix it (extend
// the deadline), which the message says.
export const assertRsvpDeadlineNotPassed = (rsvpDeadline: Date | null, now: Date = new Date()): void => {
  if (rsvpDeadline && rsvpDeadline < now) {
    throw new HttpError(
      409,
      `The RSVP deadline for this event passed on ${formatGuestDate(rsvpDeadline)}, so guests can no longer respond and a ` +
        `reminder would only confuse them. Extend the deadline first if you still want responses.`
    );
  }
};

const SKIP_PHRASES: Record<ReminderSkipReason, string> = {
  ALREADY_RESPONDED: 'already responded',
  NOT_INVITED_YET: "haven't been sent an invitation yet",
  INVITE_EXPIRED: 'have an expired invitation',
  RECENTLY_REMINDED: `were reminded in the last ${REMINDER_COOLDOWN_HOURS} hours`,
  STATE_CHANGED: 'changed while sending',
};

// "2 already responded, 1 were reminded in the last 24 hours" — the reason
// an organiser is told when a request leaves nobody to remind.
export const describeSkips = (reasons: ReminderSkipReason[]): string => {
  const counts = new Map<ReminderSkipReason, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${SKIP_PHRASES[reason]}`).join(', ');
};

export const SKIP_MESSAGES: Record<ReminderSkipReason, string> = {
  ALREADY_RESPONDED: 'They have already responded, so no reminder is needed.',
  NOT_INVITED_YET: "Their invitation hasn't been sent yet — send the invitation first; a reminder follows one.",
  INVITE_EXPIRED: 'Their invitation has expired, so its link no longer works. They need a new invitation, not a reminder.',
  RECENTLY_REMINDED: `They were reminded within the last ${REMINDER_COOLDOWN_HOURS} hours.`,
  STATE_CHANGED: 'They responded, or were reminded by another request, while this one was sending.',
};
