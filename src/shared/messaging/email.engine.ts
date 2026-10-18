import { Resend } from 'resend';
import { type EngineSendResult } from './messaging.types.js';

// ─────────────────────────────────────────
//  EMAIL ENGINE
//
//  Knows Resend and nothing else — no guest/invite/event/tier concepts.
//  Sends one email to one address and reports success or a human-readable
//  failure reason. Every email this backend sends goes through here, built
//  by renderEmail (email-layout.ts): `text` is required, so no message can
//  leave without its plain-text part.
//
//  Two ways in: sendEmail for one message, sendEmailBatch for many (guest
//  sends: invitations, reminders, announcements, the cancellation email).
// ─────────────────────────────────────────

const resend = new Resend(process.env.RESEND_API_KEY);

export interface OutgoingEmail {
  to: string;
  // A full From header, `"Name" <address>` — build it with formatFromHeader
  // (email-address.util.ts), never by hand.
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

// The two sender addresses, from env config. Read at call time.
export const inviteSenderAddress = (): string => process.env.RESEND_INVITE_EMAIL ?? 'onboarding@resend.dev';
export const authSenderAddress = (): string => process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';
export const eventSenderAddress = (): string => process.env.RESEND_EVENT_EMAIL ?? 'onboarding@resend.dev';
const toResendPayload = (email: OutgoingEmail) => ({
  from: email.from,
  to: email.to,
  subject: email.subject,
  html: email.html,
  text: email.text,
  ...(email.replyTo ? { replyTo: email.replyTo } : {}),
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Email delivery failed';

export const sendEmail = async (email: OutgoingEmail): Promise<EngineSendResult> => {
  try {
    const { data, error } = await resend.emails.send(toResendPayload(email));
    if (error) return { ok: false, reason: error.message ?? 'Email delivery failed' };
    return { ok: true, ...(data?.id ? { messageId: data.id } : {}) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
};

// Resend's batch endpoint takes at most this many emails per call.
export const RESEND_BATCH_LIMIT = 100;

// One call for up to RESEND_BATCH_LIMIT emails. Permissive validation: an
// email Resend refuses (a malformed address) fails alone, reported by its
// index, and the rest of the batch still goes; in strict mode one bad
// address would fail all hundred. A refused call (an outage, a rate limit)
// or a thrown one fails exactly this batch's emails.
const sendOneBatch = async (emails: OutgoingEmail[]): Promise<EngineSendResult[]> => {
  try {
    const { data, error } = await resend.batch.send(emails.map(toResendPayload), { batchValidation: 'permissive' });
    if (error) {
      const reason = error.message ?? 'Email delivery failed';
      return emails.map(() => ({ ok: false, reason }));
    }
    const refused = new Map((data?.errors ?? []).map((e) => [e.index, e.message || 'Email delivery failed']));
    // No messageId: the response lists accepted ids without saying which
    // email each belongs to once some are refused, and nothing reads it.
    return emails.map((_, i) => (refused.has(i) ? { ok: false, reason: refused.get(i)! } : { ok: true }));
  } catch (err) {
    const reason = errorMessage(err);
    return emails.map(() => ({ ok: false, reason }));
  }
};

// Many emails, each its own message to its own recipient (no one sees
// another's address), sent RESEND_BATCH_LIMIT at a time, one batch after
// another. Never throws. Returns one result per email, in the order given;
// a failed batch fails only its own emails, and the next batch still goes.
export const sendEmailBatch = async (emails: OutgoingEmail[]): Promise<EngineSendResult[]> => {
  const results: EngineSendResult[] = [];
  for (let start = 0; start < emails.length; start += RESEND_BATCH_LIMIT) {
    results.push(...(await sendOneBatch(emails.slice(start, start + RESEND_BATCH_LIMIT))));
  }
  return results;
};
