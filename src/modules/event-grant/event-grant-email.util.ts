import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { LAUNCH_CONTACT_EMAIL } from '../subscription-tier-config/tier-refusal-wording.util.js';

// ─────────────────────────────────────────
//  "<EVENT> IS READY IN YOUR ACCOUNT" — a granted event (event-grant.service.ts)
//
//  To the organisation's address (Tenant.email). An account email, calm,
//  one job, no seal. The event name is the super admin's typing: plain text
//  into the layout, sanitised as header text in the subject.
//
//  From:   "e-velope" <RESEND_EVENT_EMAIL>, Reply-To the admin address
//  Button: "Open the event" → <FRONTEND_BASE_URL>/events/<id>/manage
// ─────────────────────────────────────────

export const buildGrantedEventEmail = (input: { to: string; organisationName: string; eventId: string; eventName: string }): OutgoingEmail => {
  const name = sanitizeDisplayName(input.eventName, 80) || 'Your event';
  const subject = `${name} is ready in your e-velope account`;
  const { html, text } = renderEmail({
    subject,
    preheader: "We've set up an event for you. It's a draft until you publish it.",
    blocks: [
      { kind: 'title', text: `${input.eventName} is ready` },
      {
        kind: 'paragraph',
        text: `We've added ${input.eventName} to ${input.organisationName}'s events on e-velope. It's a draft: check the details, add your guests and publish it when you're ready. Nothing has been sent to anyone.`,
      },
      { kind: 'paragraph', text: "It doesn't count towards your plan's event limit." },
      { kind: 'button', label: 'Open the event', href: frontendUrl(`/events/${encodeURIComponent(input.eventId)}/manage`) },
    ],
    reason: `You received this because e-velope gave ${input.organisationName} an event.`,
  });
  return { to: input.to, from: formatFromHeader('e-velope', eventSenderAddress()), replyTo: LAUNCH_CONTACT_EMAIL, subject, html, text };
};
