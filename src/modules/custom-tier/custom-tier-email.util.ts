import { renderEmail } from '../../shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../shared/messaging/email-address.util.js';
import { eventSenderAddress, type OutgoingEmail } from '../../shared/messaging/email.engine.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';
import { formatGuestDate } from '../../shared/utils/guest-date.util.js';
import { LAUNCH_CONTACT_EMAIL } from '../subscription-tier-config/tier-refusal-wording.util.js';

// ─────────────────────────────────────────
//  CUSTOM TIER EMAILS — account emails, calm, one job, no seal (like the
//  media-purge reminder). Tier and organisation names are a super admin's or
//  an organiser's typing: plain text into the layout (which escapes it) and
//  sanitised as header text in a subject. Dates are UTC, like every date the
//  server writes.
//
//  From: "e-velope" <RESEND_EVENT_EMAIL>. Replies go to the admin address.
// ─────────────────────────────────────────

const from = (): string => formatFromHeader('e-velope', eventSenderAddress());

// To the admin address: a tenant asked for a custom tier. Reply-To is the
// contact they gave, so answering the email reaches them.
// Button: "Open requests" → <FRONTEND_BASE_URL>/admin/custom-tier-requests.
export const buildCustomTierRequestEmail = (input: {
  organisationName: string;
  needs: string;
  expectedEvents: number | null;
  expectedGuests: number | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
}): OutgoingEmail => {
  const subject = `Custom plan request from ${sanitizeDisplayName(input.organisationName, 80) || 'an organisation'}`;
  const { html, text } = renderEmail({
    subject,
    preheader: `${input.contactName} would like a custom plan.`,
    blocks: [
      { kind: 'title', text: `Custom plan request from ${input.organisationName}` },
      { kind: 'message', text: input.needs },
      {
        kind: 'details',
        groups: [
          {
            heading: 'Roughly',
            lines: [
              `Events: ${input.expectedEvents ?? 'not given'}`,
              `Guests: ${input.expectedGuests ?? 'not given'}`,
            ],
          },
          {
            heading: 'Contact',
            lines: [input.contactName, input.contactEmail, ...(input.contactPhone ? [input.contactPhone] : [])],
          },
        ],
      },
      { kind: 'button', label: 'Open requests', href: frontendUrl('/admin/custom-tier-requests') },
    ],
    reason: 'You received this because an organisation asked for a custom plan on e-velope.',
  });
  return { to: LAUNCH_CONTACT_EMAIL, from: from(), replyTo: input.contactEmail, subject, html, text };
};

// To the request's contact: the super admin's short note.
export const buildCustomTierRequestReplyEmail = (input: { to: string; contactName: string; organisationName: string; note: string }): OutgoingEmail => {
  const subject = 'About your custom plan request';
  const { html, text } = renderEmail({
    subject,
    preheader: `A reply about ${input.organisationName}'s custom plan request.`,
    blocks: [
      { kind: 'title', text: 'About your custom plan request' },
      { kind: 'paragraph', text: `Hi ${input.contactName}, here's a reply about ${input.organisationName}'s request for a custom plan:` },
      { kind: 'message', text: input.note },
      { kind: 'paragraph', text: `Reply to this email, or write to ${LAUNCH_CONTACT_EMAIL}.`, muted: true },
    ],
    reason: `You received this because you asked for a custom plan for ${input.organisationName} on e-velope.`,
  });
  return { to: input.to, from: from(), replyTo: LAUNCH_CONTACT_EMAIL, subject, html, text };
};

// "Your Free trial plan ends on 18 December 2026" — 7 days before.
// Button: "See your plan" → <FRONTEND_BASE_URL>/subscription.
export const buildCustomTierEndingEmail = (input: { to: string; organisationName: string; tierName: string; endsAt: Date }): OutgoingEmail => {
  const date = formatGuestDate(input.endsAt);
  const tier = sanitizeDisplayName(input.tierName, 60) || 'current';
  const subject = `Your ${tier} plan ends on ${date}`;
  const { html, text } = renderEmail({
    subject,
    preheader: `After ${date}, ${input.organisationName} moves to the free Spark plan.`,
    blocks: [
      { kind: 'title', text: `Your ${input.tierName} plan ends on ${date}` },
      {
        kind: 'paragraph',
        text: `${input.organisationName}'s ${input.tierName} plan ends on ${date}. After that, your account moves to the free Spark plan and its limits.`,
      },
      {
        kind: 'paragraph',
        text: `Your events and guests are kept. If you'd like to keep your current plan, contact us at ${LAUNCH_CONTACT_EMAIL}.`,
      },
      { kind: 'button', label: 'See your plan', href: frontendUrl('/subscription') },
    ],
    reason: `You received this because ${input.organisationName} is on e-velope's ${input.tierName} plan.`,
  });
  return { to: input.to, from: from(), replyTo: LAUNCH_CONTACT_EMAIL, subject, html, text };
};
