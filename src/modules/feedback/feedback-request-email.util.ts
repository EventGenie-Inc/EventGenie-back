import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../shared/messaging/email-address.util.js';
import { authSenderAddress, eventSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';

// ─────────────────────────────────────────
//  "HOW DID <EVENT> GO?" — the feedback request
//
//  An account email to an organiser, so it reads like the team invitation
//  (user-invite-email.util.ts): calm, one job, no seal. The event name is
//  organiser-typed: plain text into the layout (which escapes it) and, in
//  the subject, sanitised as header text.
//
//  From:   "e-velope" <RESEND_FROM_EMAIL>
//  Button: "Share your feedback" → <FRONTEND_BASE_URL>/events/<id>/feedback
// ─────────────────────────────────────────

export const feedbackPageLink = (eventId: string): string => frontendUrl(`/events/${encodeURIComponent(eventId)}/feedback`);

export const buildFeedbackRequestEmail = (input: { to: string; eventId: string; eventName: string }): OutgoingEmail => {
  const subject = `How did ${sanitizeDisplayName(input.eventName, 80) || 'your event'} go?`;

  const { html, text } = renderEmail({
    subject,
    preheader: `Tell us how ${input.eventName} went. It takes about two minutes.`,
    blocks: [
      { kind: 'title', text: `How did ${input.eventName} go?` },
      { kind: 'paragraph', text: 'We hope it went well. Tell us what worked and what we could do better: it takes about two minutes.' },
      {
        kind: 'paragraph',
        text: 'You can also tell us whether we may mention your name or share a few of your photos. Each of these is optional, and you can change your mind later.',
      },
      { kind: 'button', label: 'Share your feedback', href: feedbackPageLink(input.eventId) },
    ],
    reason: `You received this because you organised ${input.eventName} on e-velope.`,
  });

  return { to: input.to, from: formatFromHeader('e-velope', eventSenderAddress()), subject, html, text };
};
