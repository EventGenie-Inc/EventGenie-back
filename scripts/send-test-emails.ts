import 'dotenv/config';
import {
  buildInviteEmail,
  buildReminderEmail,
  buildRegistrationEmail,
  buildRegistrationResendEmail,
  buildAnnouncementEmail,
  buildCancellationEmail,
  buildInviteRsvpLink,
  type InviteEmailInput,
} from '../src/modules/invite/invite-message.util.js';
import { buildOtpEmail, buildPasswordResetEmail } from '../src/modules/auth/auth-email.util.js';
import { sendEmail } from '../src/shared/messaging/email.engine.js';
import { frontendUrl } from '../src/shared/utils/frontend-url.util.js';

// ─────────────────────────────────────────
//  SEND ONE OF EACH EMAIL, FOR A HUMAN TO LOOK AT
//
//  One of every email: invitation, reminder, registration and its re-send,
//  an announcement, the cancellation email, sign-in code and password
//  reset, through Resend, to the address in TEST_EMAIL_TO and nowhere else.
//  Sample content only: no database, and the links lead nowhere real.
//  The Reply-To is TEST_EMAIL_TO too, so replying to the test invite can
//  be checked from the same inbox.
//
//    TEST_EMAIL_TO=you@example.com npx tsx scripts/send-test-emails.ts
// ─────────────────────────────────────────

const to = process.env.TEST_EMAIL_TO?.trim();
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('TEST_EMAIL_TO is not set to an email address. Refusing to send anything.');
  process.exit(1);
}

const input: InviteEmailInput = {
  eventName: 'Thandi & Sipho’s Wedding',
  // A quote in the host name checks the From header's quoting end to end.
  hostName: 'Thandi & Sipho "TS"',
  days: [
    {
      label: 'Ceremony',
      date: new Date('2027-06-05'),
      startTime: new Date('2027-06-05T14:00:00Z'),
      endTime: new Date('2027-06-05T16:30:00Z'),
      location: "St George's Cathedral",
      address: '5 Wale St, Cape Town',
    },
    {
      label: 'Brunch',
      date: new Date('2027-06-06'),
      startTime: new Date('2027-06-06T10:00:00Z'),
      endTime: null,
      location: 'Kirstenbosch Tea Room',
      address: 'Rhodes Dr, Newlands',
    },
  ],
  fallbackDateLabel: null,
  rsvpDeadline: new Date('2027-05-20T23:59:59Z'),
  rsvpLink: buildInviteRsvpLink('test-email-preview-token'),
  design: {
    kind: 'UPLOAD',
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    width: 864,
    height: 576,
    altText: 'Pink dahlias in a summer garden',
  },
  organiserEmail: to,
};

const emails = {
  invite: buildInviteEmail(input),
  reminder: buildReminderEmail(input),
  registration: buildRegistrationEmail(input),
  registrationResend: buildRegistrationResendEmail(input),
  // A multi-line body with markup in it: the lines stay lines, and the
  // markup arrives as text.
  announcement: buildAnnouncementEmail({
    eventName: input.eventName,
    hostName: input.hostName,
    organiserEmail: to,
    selfRegistered: false,
    subject: 'Buses leave at 18:00',
    body:
      'Hi everyone,\n\nThe buses to the reception leave from the cathedral at 18:00 sharp.\n' +
      'Look for the <b>blue</b> signs.\n\nSee you there!',
    rsvpLink: input.rsvpLink,
  }),
  cancellation: buildCancellationEmail({
    eventName: input.eventName,
    hostName: input.hostName,
    organiserEmail: to,
    selfRegistered: false,
    days: input.days,
    note: "We're so sorry to let you know.\nWe'll be in touch about a new date.",
  }),
  otp: buildOtpEmail({ to, username: 'Test', code: '482913', validMinutes: 10 }),
  reset: buildPasswordResetEmail({ to, username: 'Test', resetLink: frontendUrl('/reset-password?test=1') }),
};

let failed = false;
for (const [kind, email] of Object.entries(emails)) {
  const result = await sendEmail({ ...email, to });
  console.log(`${kind.padEnd(18)} ${result.ok ? `sent  id=${result.messageId ?? '(none returned)'}` : `FAILED ${result.reason}`}`);
  console.log(`${''.padEnd(19)}From: ${email.from}`);
  console.log(`${''.padEnd(19)}Subject: ${email.subject}`);
  if (!result.ok) failed = true;
}
process.exit(failed ? 1 : 0);
