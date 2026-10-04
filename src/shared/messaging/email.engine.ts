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

export const sendEmail = async (email: OutgoingEmail): Promise<EngineSendResult> => {
  try {
    const { data, error } = await resend.emails.send({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    });
    if (error) return { ok: false, reason: error.message ?? 'Email delivery failed' };
    return { ok: true, ...(data?.id ? { messageId: data.id } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Email delivery failed';
    return { ok: false, reason: message };
  }
};
