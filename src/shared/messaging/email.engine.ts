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
//  Three ways in: sendEmail for one message; sendEmailBatch for many
//  (announcements, the cancellation email and the other batched sends);
//  sendEmailAttempt for the email-send worker, one paced call per email
//  (invitations and reminders, with the guest QR code as an inline image,
//  which Resend's batch endpoint cannot take).
// ─────────────────────────────────────────

const resend = new Resend(process.env.RESEND_API_KEY);

// An image shown in the body, referenced from the HTML as `cid:<contentId>`
// (the layout's `qr` block). Sent as an inline attachment, so it shows
// without "load images" and its content never travels in an image URL.
export interface InlineImage {
  contentId: string;
  filename: string;
  contentType: 'image/png';
  content: Buffer;
}

interface EmailMessage {
  to: string;
  // A full From header, `"Name" <address>` — build it with formatFromHeader
  // (email-address.util.ts), never by hand.
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

// An email with no attachments: what every builder returns, and all the
// batch endpoint can carry ("The attachments field is not supported yet",
// Resend's batch docs; the SDK's own CreateBatchEmailOptions omits it).
export type OutgoingEmail = EmailMessage & { inlineImages?: never };

// An email that may carry inline images (a guest's QR code). Goes through
// sendEmail or sendEmailAttempt, never sendEmailBatch: the compiler refuses
// one with images there.
export type OutgoingEmailWithImages = EmailMessage & { inlineImages?: InlineImage[] };

// The two sender addresses, from env config. Read at call time.
export const inviteSenderAddress = (): string => process.env.RESEND_INVITE_EMAIL ?? 'onboarding@resend.dev';
export const authSenderAddress = (): string => process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';
export const eventSenderAddress = (): string => process.env.RESEND_EVENT_EMAIL ?? 'onboarding@resend.dev';
const toResendPayload = (email: OutgoingEmailWithImages) => ({
  from: email.from,
  to: email.to,
  subject: email.subject,
  html: email.html,
  text: email.text,
  ...(email.replyTo ? { replyTo: email.replyTo } : {}),
  // Base64, not the Buffer: the SDK passes `content` through as it is, and
  // a Buffer would be serialised as {"type":"Buffer","data":[...]}.
  ...(email.inlineImages?.length
    ? {
        attachments: email.inlineImages.map((image) => ({
          content: image.content.toString('base64'),
          filename: image.filename,
          contentType: image.contentType,
          contentId: image.contentId,
        })),
      }
    : {}),
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Email delivery failed';

export const sendEmail = async (email: OutgoingEmailWithImages): Promise<EngineSendResult> => {
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

// ─────────────────────────────────────────
//  ONE EMAIL PER CALL, PACED — for the email-send worker
//
//  Invitations and reminders carry an inline QR code, which Resend's batch
//  endpoint can't take, so the email-send worker (email-send.worker.ts)
//  sends them one call each. Every such call in this process first takes
//  the next slot of one shared schedule (waitForSendSlot), so at most
//  emailSendsPerSecond() start per second. Resend's limit is 10 requests a
//  second for the whole team, every API key and server instance together;
//  the default 6 leaves room for what isn't paced (sign-in codes,
//  registrations, batches).
//
//  sendEmailAttempt makes exactly one call, with an idempotency key: the
//  same key again within 24 hours is the same email to Resend, never a
//  second one, so the worker may retry an email whose first call's outcome
//  it never learned. It says whether a failure is worth retrying; the
//  worker decides when.
// ─────────────────────────────────────────

export const DEFAULT_EMAIL_SENDS_PER_SECOND = 6;

// EMAIL_SENDS_PER_SECOND overrides the default (Resend raises a team's
// limit on request). Read at call time.
export const emailSendsPerSecond = (): number => {
  const configured = Number(process.env.EMAIL_SENDS_PER_SECOND);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_EMAIL_SENDS_PER_SECOND;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The next free slot, shared by every paced call in this process.
let nextSlotAt = 0;

export const waitForSendSlot = async (): Promise<void> => {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + 1000 / emailSendsPerSecond();
  if (slot > now) await sleep(slot - now);
};

export type EmailAttemptResult =
  | { ok: true; messageId?: string }
  // The key was already used for this email with a different body: an
  // earlier call with it was accepted, so the email went.
  | { ok: true; alreadySent: true }
  | { ok: false; reason: string; retryable: boolean };

// Worth trying again: rate limited, Resend's own trouble, a concurrent
// call with the same key still in progress, or no answer at all. Anything
// else (an invalid address, a rejected sender) would fail the same way.
const isRetryable = (error: { name?: string; statusCode?: number | null }): boolean =>
  error.statusCode === 429 ||
  error.name === 'rate_limit_exceeded' ||
  error.name === 'concurrent_idempotent_requests' ||
  error.statusCode == null ||
  error.statusCode >= 500;

export const sendEmailAttempt = async (email: OutgoingEmailWithImages, idempotencyKey: string): Promise<EmailAttemptResult> => {
  try {
    const { data, error } = await resend.emails.send(toResendPayload(email), { idempotencyKey });
    if (!error) return { ok: true, ...(data?.id ? { messageId: data.id } : {}) };
    if (error.name === 'invalid_idempotent_request') return { ok: true, alreadySent: true };
    return { ok: false, reason: error.message ?? 'Email delivery failed', retryable: isRetryable(error) };
  } catch (err) {
    return { ok: false, reason: errorMessage(err), retryable: true };
  }
};
