import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader } from '../../shared/messaging/email-address.util.js';
import { authSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';

// ─────────────────────────────────────────
//  AUTH EMAILS — sign-in code and password reset
//
//  The same layout as the guest emails (email-layout.ts), but calm and
//  functional: no seal, no e-velope wordplay, one job each. Values are
//  passed as plain text; renderEmail escapes them (the username is
//  user-typed).
//
//  From: "e-velope" <RESEND_FROM_EMAIL>
// ─────────────────────────────────────────

// Firebase's password-reset links are valid for one hour; the Admin SDK
// can't change that, so this only describes it.
export const PASSWORD_RESET_LINK_TTL_TEXT = '1 hour';

const IGNORE_SIGN_IN = "If you didn't try to sign in, you can ignore this email.";
const IGNORE_RESET = "If you didn't ask to reset your password, you can ignore this email. Your password won't change.";

const authFrom = (): string => formatFromHeader('e-velope', authSenderAddress());

export const buildOtpEmail = (input: { to: string; username: string; code: string; validMinutes: number }): OutgoingEmail => {
  const subject = 'Your e-velope sign-in code';
  const { html, text } = renderEmail({
    subject,
    preheader: `Your code is ${input.code}. It's valid for ${input.validMinutes} minutes.`,
    blocks: [
      { kind: 'title', text: 'Your sign-in code' },
      { kind: 'paragraph', text: `Hello ${input.username}, enter this code to finish signing in.` },
      { kind: 'code', text: input.code },
      { kind: 'paragraph', text: `It's valid for ${input.validMinutes} minutes.` },
      { kind: 'paragraph', text: IGNORE_SIGN_IN, muted: true },
    ],
    reason: 'You received this because a sign-in was started with this email address.',
  });
  return { to: input.to, from: authFrom(), subject, html, text };
};

export const buildPasswordResetEmail = (input: { to: string; username: string; resetLink: string }): OutgoingEmail => {
  const subject = 'Reset your e-velope password';
  const { html, text } = renderEmail({
    subject,
    preheader: `Choose a new password. The link expires in ${PASSWORD_RESET_LINK_TTL_TEXT}.`,
    blocks: [
      { kind: 'title', text: 'Reset your password' },
      { kind: 'paragraph', text: `Hello ${input.username}, we received a request to reset your password. Choose a new one below.` },
      { kind: 'button', label: 'Reset password', href: input.resetLink },
      { kind: 'paragraph', text: `This link expires in ${PASSWORD_RESET_LINK_TTL_TEXT}.` },
      { kind: 'paragraph', text: IGNORE_RESET, muted: true },
    ],
    reason: 'You received this because a password reset was requested for this email address.',
  });
  return { to: input.to, from: authFrom(), subject, html, text };
};
