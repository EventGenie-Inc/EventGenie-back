import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildInviteEmail,
  buildReminderEmail,
  buildRegistrationEmail,
  buildRegistrationResendEmail,
  type InviteEmailInput,
} from '../../src/modules/invite/invite-message.util.js';
import { buildOtpEmail, buildPasswordResetEmail } from '../../src/modules/auth/auth-email.util.js';
import {
  EMAIL_LAYOUT_MARKER,
  EMAIL_FOOTER_LINE,
  EMAIL_LOGO_PATH,
  EMAIL_SEAL_PATH,
} from '../../src/shared/messaging/email-layout.js';
import { formatFromHeader, sanitizeDisplayName } from '../../src/shared/messaging/email-address.util.js';

// ─────────────────────────────────────────
//  EVERY EMAIL IS ONE FAMILY
//
//  Invitations, reminders, sign-in codes and password resets all come out
//  of the one layout (email-layout.ts), each with a plain-text part, every
//  user value escaped, no domain written by hand, and the organiser's words
//  kept out of the headers' control characters. Pure builders, no database.
// ─────────────────────────────────────────

const BASE = 'https://frontend.example.test';
const INVITE_ADDRESS = 'invitations@sender.example.test';
const AUTH_ADDRESS = 'auth@sender.example.test';
const RSVP_LINK = `${BASE}/rsvp?token=abc123`;
const RESET_LINK = 'https://firebase.example.test/__/auth/action?mode=resetPassword&oobCode=xyz';
const CLOUDINARY = 'https://res.cloudinary.com/democloud/image/upload/v1700000000/eventgenie/t1/invitation-designs/e1/7d3c.png';

const HOSTILE = `<script>alert(1)</script> "&'`;
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt; &quot;&amp;&#39;';

const saved = {
  base: process.env.FRONTEND_BASE_URL,
  invite: process.env.RESEND_INVITE_EMAIL,
  auth: process.env.RESEND_FROM_EMAIL,
};
beforeAll(() => {
  process.env.FRONTEND_BASE_URL = BASE;
  process.env.RESEND_INVITE_EMAIL = INVITE_ADDRESS;
  process.env.RESEND_FROM_EMAIL = AUTH_ADDRESS;
});
afterAll(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('FRONTEND_BASE_URL', saved.base);
  restore('RESEND_INVITE_EMAIL', saved.invite);
  restore('RESEND_FROM_EMAIL', saved.auth);
});

const input = (over: Partial<InviteEmailInput> = {}): InviteEmailInput => ({
  eventName: 'Garden Party',
  hostName: 'Thandi & Sipho',
  days: [
    {
      label: 'Ceremony',
      date: new Date('2027-06-05'),
      startTime: new Date('2027-06-05T14:00:00Z'),
      endTime: new Date('2027-06-05T16:30:00Z'),
      location: 'St George’s Cathedral',
      address: '5 Wale St, Cape Town',
    },
  ],
  fallbackDateLabel: null,
  rsvpDeadline: new Date('2027-05-20T23:59:59Z'),
  rsvpLink: RSVP_LINK,
  design: null,
  organiserEmail: 'organiser@example.test',
  ...over,
});

const upload = (over: Partial<NonNullable<InviteEmailInput['design']>> = {}): InviteEmailInput['design'] => ({
  kind: 'UPLOAD',
  imageUrl: CLOUDINARY,
  width: 1200,
  height: 1500,
  altText: 'Ivory card with gold lettering',
  ...over,
});

const allEmails = (over: Partial<InviteEmailInput> = {}) => ({
  invite: buildInviteEmail(input(over)),
  reminder: buildReminderEmail(input(over)),
  registration: buildRegistrationEmail(input(over)),
  registrationResend: buildRegistrationResendEmail(input(over)),
  otp: buildOtpEmail({ to: 'a@example.test', username: 'Levy', code: '482913', validMinutes: 10 }),
  reset: buildPasswordResetEmail({ to: 'a@example.test', username: 'Levy', resetLink: RESET_LINK }),
});

describe('every email uses the shared layout', () => {
  it('invite, reminder, sign-in code and password reset all carry the layout, logo and footer', () => {
    for (const [kind, email] of Object.entries(allEmails())) {
      expect(email.html, kind).toContain(EMAIL_LAYOUT_MARKER);
      expect(email.html, kind).toContain(`src="${BASE}${EMAIL_LOGO_PATH}"`);
      expect(email.html, kind).toContain('alt="e-velope"');
      expect(email.html, kind).toContain(EMAIL_FOOTER_LINE);
      expect(email.html, kind).toMatch(/You received this because/);
    }
  });

  it('only the guest emails carry the seal, and each email has exactly one button', () => {
    const emails = allEmails();
    expect(emails.invite.html).toContain(`${BASE}${EMAIL_SEAL_PATH}`);
    expect(emails.reminder.html).toContain(`${BASE}${EMAIL_SEAL_PATH}`);
    expect(emails.registration.html).toContain(`${BASE}${EMAIL_SEAL_PATH}`);
    expect(emails.otp.html).not.toContain(EMAIL_SEAL_PATH);
    expect(emails.reset.html).not.toContain(EMAIL_SEAL_PATH);

    const buttons = (html: string) => html.split('<a ').length - 1;
    expect(buttons(emails.invite.html)).toBe(1);
    expect(buttons(emails.reminder.html)).toBe(1);
    expect(buttons(emails.registration.html)).toBe(1);
    expect(emails.registration.html).toContain('>Open your e-velope</a>');
    expect(buttons(emails.reset.html)).toBe(1);
    expect(buttons(emails.otp.html)).toBe(0);
    expect(emails.invite.html).toContain('>Open your e-velope</a>');
    expect(emails.reset.html).toContain('>Reset password</a>');
  });
});

describe('subjects and senders', () => {
  it('subjects are the brand wording and never say RSVP', () => {
    const emails = allEmails();
    expect(emails.invite.subject).toBe("You've received an e-velope from Thandi & Sipho");
    expect(emails.reminder.subject).toBe('Your e-velope from Thandi & Sipho is waiting');
    expect(emails.registration.subject).toBe("You're registered for Garden Party");
    expect(emails.otp.subject).toBe('Your e-velope sign-in code');
    expect(emails.reset.subject).toBe('Reset your e-velope password');
    for (const email of Object.values(emails)) expect(email.subject).not.toMatch(/rsvp/i);
  });

  it('the event name stands in for a missing host name', () => {
    const email = buildInviteEmail(input({ hostName: null }));
    expect(email.subject).toBe("You've received an e-velope from Garden Party");
    expect(email.from).toBe(`"Garden Party via e-velope" <${INVITE_ADDRESS}>`);
  });

  it('From is "<host> via e-velope" at the env address, Reply-To is the organiser; auth mail is from "e-velope"', () => {
    const emails = allEmails();
    expect(emails.invite.from).toBe(`"Thandi & Sipho via e-velope" <${INVITE_ADDRESS}>`);
    expect(emails.invite.replyTo).toBe('organiser@example.test');
    expect(emails.reminder.replyTo).toBe('organiser@example.test');
    expect(emails.otp.from).toBe(`"e-velope" <${AUTH_ADDRESS}>`);
    expect(emails.reset.from).toBe(`"e-velope" <${AUTH_ADDRESS}>`);
    expect(buildInviteEmail(input({ organiserEmail: null }))).not.toHaveProperty('replyTo');
  });

  it('a hostile host name cannot break out of the From header or the subject', () => {
    const hostile = 'Evil "Co"\r\nBcc: victim@example.test\u0000\u2028<boss@bank.example>\u202Etxt\\';
    const email = buildInviteEmail(input({ hostName: hostile }));

    expect(email.from).toBe(
      `"Evil \\"Co\\" Bcc: victim@example.test boss@bank.example txt\\\\ via e-velope" <${INVITE_ADDRESS}>`
    );
    for (const header of [email.from, email.subject]) {
      expect(header).not.toMatch(/[\r\n\u0000-\u001F\u007F\u2028\u2029\u202A-\u202E]/);
    }
    // Exactly one address: the display name holds no angle brackets of its own.
    expect(email.from.match(/</g)).toHaveLength(1);
    expect(email.subject).toBe(`You've received an e-velope from Evil "Co" Bcc: victim@example.test boss@bank.example txt\\`);
  });

  it('a hostile event name cannot break out of the registration subject', () => {
    const email = buildRegistrationEmail(input({ eventName: 'Party\r\nBcc: victim@example.test\u2028x' }));
    expect(email.subject).not.toMatch(/[\r\n\u2028]/);
    expect(email.subject).toBe("You're registered for Party Bcc: victim@example.test x");
    expect(email.from).toBe(formatFromHeader('Thandi & Sipho via e-velope', INVITE_ADDRESS));
    expect(email.replyTo).toBe('organiser@example.test');
  });

  it('a very long host name is capped', () => {
    const name = sanitizeDisplayName('x'.repeat(500));
    expect(name.length).toBe(60);
    expect(formatFromHeader(`${name} via e-velope`, INVITE_ADDRESS).length).toBeLessThan(120);
  });
});

describe('the uploaded design image', () => {
  it('appears for an UPLOAD design, as an explicit JPEG at 1200px shown 600px wide, with its alt text', () => {
    const html = buildInviteEmail(input({ design: upload() })).html;
    expect(html).toContain(
      'src="https://res.cloudinary.com/democloud/image/upload/f_jpg,w_1200,c_limit/v1700000000/eventgenie/t1/invitation-designs/e1/7d3c.png"'
    );
    expect(html).toContain('width="600" height="750"');
    expect(html).toContain('alt="Ivory card with gold lettering"');
    expect(html).not.toContain('f_auto');
    expect(buildReminderEmail(input({ design: upload() })).html).toContain('f_jpg,w_1200');
  });

  it('falls back to a descriptive alt when the organiser gave none', () => {
    expect(buildInviteEmail(input({ design: upload({ altText: null }) })).html).toContain('alt="Invitation to Garden Party"');
  });

  it('is absent for a TEMPLATE design, no design, or a URL not on Cloudinary', () => {
    const template = buildInviteEmail(input({
      design: { kind: 'TEMPLATE', imageUrl: CLOUDINARY, width: 1200, height: 1500, altText: 'x' },
    })).html;
    const none = buildInviteEmail(input({ design: null })).html;
    const foreign = buildInviteEmail(input({ design: upload({ imageUrl: 'https://evil.example.test/a.png' }) })).html;
    for (const html of [template, none, foreign]) {
      expect(html).not.toContain('res.cloudinary.com');
      expect(html).not.toContain('evil.example.test');
    }
  });
});

describe('every user value is escaped', () => {
  it('event name, host name, day label, venue, address and alt text, in the invite and the reminder', () => {
    const hostile = input({
      eventName: HOSTILE,
      hostName: HOSTILE,
      days: [
        { label: HOSTILE, date: new Date('2027-06-05'), location: HOSTILE, address: HOSTILE },
        { label: 'Day 2', date: new Date('2027-06-06'), location: 'Hall', address: 'Road' },
      ],
      design: upload({ altText: HOSTILE }),
    });
    for (const email of [buildInviteEmail(hostile), buildReminderEmail(hostile), buildRegistrationEmail(hostile), buildRegistrationResendEmail(hostile)]) {
      expect(email.html).not.toContain('<script>');
      expect(email.html).not.toContain(HOSTILE);
      // title, host line, footer reason, preheader, day label, venue, address, alt
      expect(email.html.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(8);
    }
  });

  it('the username in both auth emails', () => {
    const otp = buildOtpEmail({ to: 'a@example.test', username: HOSTILE, code: '123456', validMinutes: 10 });
    const reset = buildPasswordResetEmail({ to: 'a@example.test', username: HOSTILE, resetLink: RESET_LINK });
    for (const email of [otp, reset]) {
      expect(email.html).not.toContain('<script>');
      expect(email.html).toContain(ESCAPED);
    }
  });

  it('a link in an href is attribute-escaped', () => {
    const html = buildPasswordResetEmail({ to: 'a@example.test', username: 'Levy', resetLink: RESET_LINK }).html;
    expect(html).toContain('href="https://firebase.example.test/__/auth/action?mode=resetPassword&amp;oobCode=xyz"');
  });
});

describe('every email has a plain-text part with the same content', () => {
  it('invite and reminder', () => {
    const { invite, reminder } = allEmails({ design: upload() });
    for (const email of [invite, reminder]) {
      expect(email.text).toContain('Garden Party');
      expect(email.text).toContain('From Thandi & Sipho');
      expect(email.text).toContain('5 June 2027 · 14:00 – 16:30');
      expect(email.text).toContain('St George’s Cathedral');
      expect(email.text).toContain('5 Wale St, Cape Town');
      expect(email.text).toContain(`Open your e-velope:\n${RSVP_LINK}`);
      expect(email.text).toContain('[Ivory card with gold lettering]');
      expect(email.text).toContain(EMAIL_FOOTER_LINE);
      expect(email.text).not.toMatch(/<[a-z]/i);
    }
    expect(invite.text).toContain("You've received an e-velope");
    expect(reminder.text).toContain('Your e-velope is still waiting for a reply');
    expect(reminder.text).toContain('Replies close on 20 May 2027.');
  });

  it('registration', () => {
    const { registration } = allEmails({ design: upload() });
    expect(registration.text).toContain("You're registered");
    expect(registration.text).toContain('Garden Party');
    expect(registration.text).toContain('5 June 2027 · 14:00 – 16:30');
    expect(registration.text).toContain('St George’s Cathedral');
    expect(registration.text).toContain(`Open your e-velope:\n${RSVP_LINK}`);
    expect(registration.text).toContain('Open your e-velope any time to change your answer.');
    expect(registration.text).toContain('You received this because you registered for Garden Party on e-velope.');
    expect(registration.text).not.toMatch(/<[a-z]/i);
  });

  it('sign-in code and password reset', () => {
    const { otp, reset } = allEmails();
    expect(otp.text).toContain('482913');
    expect(otp.text).toContain("It's valid for 10 minutes.");
    expect(otp.text).toContain("If you didn't try to sign in, you can ignore this email.");
    expect(reset.text).toContain(`Reset password:\n${RESET_LINK}`);
    expect(reset.text).toContain('This link expires in 1 hour.');
    for (const email of [otp, reset]) {
      expect(email.text).toContain(EMAIL_FOOTER_LINE);
      expect(email.text).not.toMatch(/<[a-z]/i);
    }
  });
});

describe('the preheader', () => {
  it('names the event, the first invited day and its venue', () => {
    const html = buildInviteEmail(input({
      days: [
        { label: 'Ceremony', date: new Date('2027-06-05'), location: 'Cathedral', address: 'Wale St' },
        { label: 'Brunch', date: new Date('2027-06-06'), location: 'Tea Room', address: 'Rhodes Dr' },
      ],
    })).html;
    expect(html).toMatch(/<div style="display:none;[^"]*">Garden Party · 5 June 2027 · Cathedral&#847;/);
  });
});

describe('no domain is hardcoded', () => {
  const urlsIn = (s: string) => [...s.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);

  it('every URL in every email is built from FRONTEND_BASE_URL, or is the Cloudinary image / reset link passed in', () => {
    for (const [kind, email] of Object.entries(allEmails({ design: upload() }))) {
      const urls = [...urlsIn(email.html), ...urlsIn(email.text)].filter((u) => !u.startsWith('http://www.w3.org/'));
      expect(urls.length, kind).toBeGreaterThan(0);
      for (const url of urls) {
        const ok =
          url.startsWith(`${BASE}/`) ||
          url.startsWith('https://res.cloudinary.com/democloud/') ||
          url.replace(/&amp;/g, '&') === RESET_LINK;
        expect(ok, `${kind}: ${url}`).toBe(true);
      }
    }
  });

  it('follows the setting when it changes', () => {
    process.env.FRONTEND_BASE_URL = 'https://other.example.test/';
    try {
      const html = buildOtpEmail({ to: 'a@example.test', username: 'L', code: '1', validMinutes: 10 }).html;
      expect(html).toContain('src="https://other.example.test/brand/e-velope-logo-email.png"');
    } finally {
      process.env.FRONTEND_BASE_URL = BASE;
    }
  });
});
