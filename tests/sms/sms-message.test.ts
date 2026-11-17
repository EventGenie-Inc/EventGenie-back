import { describe, it, expect } from 'vitest';
import { buildInviteSmsBody, buildReminderSmsBody, buildInviteRsvpLink } from '../../src/modules/invite/invite-message.util.js';
import { countSmsSegments, toGsmText, gsmLength } from '../../src/shared/messaging/sms-segments.util.js';

// ─────────────────────────────────────────
//  THE TEXT MESSAGE — who it's from and why, then the guest's own link,
//  always ONE SMS: at most 160 GSM-7 septets, never UCS-2. Typographic
//  quotes, apostrophes, dashes and emoji become plain characters or are
//  left out, so they never switch a text to 70-character UCS-2.
// ─────────────────────────────────────────

const TOKEN = 'a'.repeat(64);
// What production sends: the frontend address from FRONTEND_BASE_URL.
const LINK = buildInviteRsvpLink(TOKEN);
const DEADLINE = new Date('2026-12-05T00:00:00Z');

const LONG_HOST = 'Thandiwe & Sipho Mokoena-Dlamini';
const LONG_EVENT = 'The Mokoena-Dlamini Family’s Twenty-Fifth Wedding Anniversary Celebration Weekend';

const expectOneGsmPart = (text: string) => {
  const count = countSmsSegments(text);
  expect(count.encoding).toBe('GSM-7');
  expect(count.units).toBeLessThanOrEqual(160);
  expect(count.segments).toBe(1);
};

describe('the invitation text', () => {
  it('says who it is from and why, then the link', () => {
    expect(buildInviteSmsBody('Thandi', 'Year-End Party', LINK)).toBe(`Thandi invites you to Year-End Party: ${LINK}`);
  });

  it('does not repeat the event as the host when they are the same', () => {
    expect(buildInviteSmsBody('Year-End Party', 'Year-End Party', LINK)).toBe(`You're invited to Year-End Party: ${LINK}`);
    expect(buildInviteSmsBody(null, 'Year-End Party', LINK)).toBe(`You're invited to Year-End Party: ${LINK}`);
  });

  it('a typographic apostrophe does not push it past 160 or into UCS-2', () => {
    // Exactly 160 with a plain apostrophe; the curly one is one character
    // too, but would make the whole text UCS-2 (70 a part: 3 parts) if sent.
    const room = 160 - gsmLength(` invites you to : ${LINK}`);
    const host = 'Thandi’s family';
    const event = 'x'.repeat(room - host.length);
    const text = buildInviteSmsBody(host, event, LINK);
    expect(text).toContain("Thandi's family");
    expect(text).not.toContain('’');
    expect(gsmLength(text)).toBe(160);
    expectOneGsmPart(text);
    // Sent as typed, the same text would cost three parts.
    expect(countSmsSegments(text.replace("'", '’')).segments).toBe(3);
  });

  it('quotes, dashes, ellipses and emoji are made plain or left out', () => {
    const text = buildInviteSmsBody('“Lebo” — Events 🎉', 'Gala… night – 2026 🥂', LINK);
    expect(text).toBe(`"Lebo" - Events invites you to Gala... night - 2026: ${LINK}`);
    expectOneGsmPart(text);
  });

  it('a long host and event name are cut to fit one SMS, each ending in "..."', () => {
    const text = buildInviteSmsBody(LONG_HOST, LONG_EVENT, LINK);
    expectOneGsmPart(text);
    expect(text.endsWith(`: ${LINK}`)).toBe(true);
    expect(text).toMatch(/^Thandiwe & Sipho.*\.\.\. invites you to The Mokoena.*\.\.\.: /);
  });
});

describe('the reminder text', () => {
  it('says it is a reminder, who from, the event, the deadline and the link', () => {
    expect(buildReminderSmsBody('Thandi', 'Year-End Party', LINK, DEADLINE)).toBe(
      `Reminder from Thandi: reply to Year-End Party by 5 Dec ${LINK}`
    );
    expect(buildReminderSmsBody('Thandi', 'Year-End Party', LINK, null)).toBe(`Reminder from Thandi: reply to Year-End Party ${LINK}`);
  });

  it('a long host and event name still fit one SMS, with and without a deadline', () => {
    expectOneGsmPart(buildReminderSmsBody(LONG_HOST, LONG_EVENT, LINK, DEADLINE));
    expectOneGsmPart(buildReminderSmsBody(LONG_HOST, LONG_EVENT, LINK, null));
  });

  it('never says RSVP', () => {
    expect(buildReminderSmsBody('Thandi', 'Party', LINK, DEADLINE)).not.toMatch(/RSVP/);
    expect(buildInviteSmsBody('Thandi', 'Party', LINK)).not.toMatch(/RSVP/);
  });
});

describe('with the short link (production: https://www.e-velope.co.za/r/<code>)', () => {
  const SHORT = 'https://www.e-velope.co.za/r/AbC123xYz9';

  it('names are only cut when they truly don’t fit', () => {
    // 32 + 60 characters of names fit beside the 39-character link.
    const event = 'The Mokoena-Dlamini Twenty-Fifth Anniversary Celebration 2026';
    expect(buildInviteSmsBody(LONG_HOST, event, SHORT)).toBe(`${LONG_HOST} invites you to ${event}: ${SHORT}`);
    // An event name that needs every character left still isn't cut.
    const exact = 'x'.repeat(160 - gsmLength(`${LONG_HOST} invites you to : ${SHORT}`));
    const text = buildInviteSmsBody(LONG_HOST, exact, SHORT);
    expect(text).toBe(`${LONG_HOST} invites you to ${exact}: ${SHORT}`);
    expect(gsmLength(text)).toBe(160);
    // One character more, and only the event's name is cut.
    const over = buildInviteSmsBody(LONG_HOST, `${exact}y`, SHORT);
    expect(over.startsWith(`${LONG_HOST} invites you to `)).toBe(true);
    expect(over).toContain('...');
    expectOneGsmPart(over);
  });

  it('long names: exact texts and lengths, for the report', () => {
    const invite = buildInviteSmsBody(LONG_HOST, LONG_EVENT, SHORT);
    const reminder = buildReminderSmsBody(LONG_HOST, LONG_EVENT, SHORT, DEADLINE);
    expectOneGsmPart(invite);
    expectOneGsmPart(reminder);
    // The host's whole name, in both.
    expect(invite.startsWith(`${LONG_HOST} invites you to `)).toBe(true);
    expect(reminder.startsWith(`Reminder from ${LONG_HOST}: `)).toBe(true);
    console.log(`[sms report] invitation (${gsmLength(invite)}): ${invite}`);
    console.log(`[sms report] reminder (${gsmLength(reminder)}): ${reminder}`);
  });
});

describe('toGsmText', () => {
  it('keeps GSM letters, folds other accents, drops what GSM cannot carry', () => {
    // é and Ç are GSM; ë and ô aren't, and lose their accents.
    expect(toGsmText('Zoë & Chloé’s Ça-va côte 🎂')).toBe("Zoe & Chloé's Ça-va cote");
    expect(toGsmText('  two\nlines\t ')).toBe('two lines');
  });
});
