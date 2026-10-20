import { type EventEmailKind } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { eventEmailClaimRepository } from './event-email-claim.repository.js';

// ─────────────────────────────────────────
//  DAILY EMAIL LIMIT — invitations and reminders, per event
//
//  At most EVENT_EMAILS_PER_DAY invitation and reminder emails per event in
//  any rolling 24 hours. It protects the shared Resend quota from mistakes
//  (the same list sent over and over, a script calling send in a loop),
//  not from organisers doing their job.
//
//  Why 2,000: a 300-guest event (Celebrate's whole guest limit) sends 300
//  invitations and, the next morning or the same day, one reminder round of
//  at most 300: 600 emails, under a third of the allowance, leaving room for
//  single resends and corrections. A 1,000-guest event still fits its
//  invitations and a reminder round into one day. Past that (an unlimited
//  plan's very large private event) the sends spread over two days, which
//  is the trade for a ceiling a runaway loop reaches within minutes rather
//  than one that only stops it after tens of thousands of emails. Public
//  events send no invitations or reminders at all (registrants get their
//  own email, limited per address and per event elsewhere).
//
//  What counts: every invitation email (bulk send or a single resend) and
//  every reminder email, counted when the send is CLAIMED, before anything
//  goes, so a refused email still counts (it used the request). SMS is not
//  counted (it has its own quota), nor are announcements (their own limit,
//  announcement.service.ts), the cancellation email or registration emails.
//
//  All-or-nothing, like the SMS quota: a send that would pass the limit is
//  refused whole with 429 EVENT_EMAIL_DAILY_LIMIT, and nothing goes.
//  Claimed under a row lock on the event (EventEmailClaim), so two sends
//  racing can't both pass it.
// ─────────────────────────────────────────

export const EVENT_EMAILS_PER_DAY = 2000;
export const EVENT_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EVENT_EMAIL_DAILY_LIMIT = 'EVENT_EMAIL_DAILY_LIMIT';

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// No clock time, for the reason announcement.service.ts's refusal gives
// none: the server could only write UTC.
export const eventEmailLimitRefusal = (wanted: number, remaining: number): HttpError =>
  new HttpError(
    429,
    remaining === 0
      ? `This event has sent the most invitation and reminder emails allowed in 24 hours ` +
        `(${EVENT_EMAILS_PER_DAY.toLocaleString('en-US')}), so nothing was sent. Try again later.`
      : `This would send ${plural(wanted, 'email')}, but only ${plural(remaining, 'more')} can go from this event ` +
        `in the next 24 hours (the limit is ${EVENT_EMAILS_PER_DAY.toLocaleString('en-US')} a day), so nothing was sent. ` +
        `Choose fewer guests, or try again later.`,
    EVENT_EMAIL_DAILY_LIMIT
  );

// Claims `emailCount` emails against the event's allowance, or throws the
// 429 and claims nothing. Zero emails (an all-SMS send) claims nothing and
// never refuses.
export const claimEventEmails = async (
  eventId: string,
  kind: EventEmailKind,
  emailCount: number,
  claimedBy: string
): Promise<void> => {
  if (emailCount <= 0) return;
  await eventEmailClaimRepository.withEventEmailLock(eventId, async (tx) => {
    const recent = await eventEmailClaimRepository.findSince(eventId, new Date(Date.now() - EVENT_EMAIL_WINDOW_MS), tx);
    const used = recent.reduce((sum, claim) => sum + claim.emailCount, 0);
    const remaining = Math.max(0, EVENT_EMAILS_PER_DAY - used);
    if (emailCount > remaining) throw eventEmailLimitRefusal(emailCount, remaining);
    await eventEmailClaimRepository.create({ eventId, kind, emailCount, claimedBy }, tx);
  });
};
