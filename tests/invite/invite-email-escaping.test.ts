import { describe, it, expect } from 'vitest';
import { buildInviteEmailHtml, buildReminderEmailHtml } from '../../src/modules/invite/invite-message.util.js';

// ─────────────────────────────────────────
//  SECURITY SWEEP BEFORE G3 — FIX 3
//
//  An organiser-typed event name reaches a guest's inbox verbatim today
//  unless escaped — buildInviteEmailHtml did not; buildReminderEmailHtml
//  already did (see that file's header comment on why dateLabel/rsvpLink
//  stay unescaped: they are never free text a user types).
// ─────────────────────────────────────────

const HOSTILE_NAME = `<script>alert(1)</script> "&'`;
const ESCAPED_NAME = '&lt;script&gt;alert(1)&lt;/script&gt; &quot;&amp;&#39;';

// The venue belongs to each event day, so the builders take the guest's
// invited days (label, date, venue name, address).
const day = (over: Partial<{ label: string; location: string; address: string }> = {}) => ({
  label: 'Day 1', date: new Date('2027-01-01'), location: 'Some Venue', address: '1 Road', ...over,
});

describe('invite/reminder email HTML — organiser-typed values are escaped', () => {
  it('buildInviteEmailHtml renders the event name escaped, not as live markup', () => {
    const html = buildInviteEmailHtml(HOSTILE_NAME, [day()], null, 'https://example.test/rsvp?token=abc');

    expect(html).not.toContain(HOSTILE_NAME);
    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_NAME);
  });

  it('buildInviteEmailHtml renders the venue escaped too — single day', () => {
    const html = buildInviteEmailHtml('Some Event', [day({ location: HOSTILE_NAME })], null, 'https://example.test/rsvp?token=abc');

    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_NAME);
  });

  it('buildInviteEmailHtml escapes every day line — label, venue and address — for multi-day invites', () => {
    const html = buildInviteEmailHtml(
      'Some Event',
      [day({ label: HOSTILE_NAME }), day({ label: 'Day 2', address: HOSTILE_NAME })],
      null,
      'https://example.test/rsvp?token=abc'
    );

    expect(html).not.toContain('<script>');
    expect(html.split(ESCAPED_NAME)).toHaveLength(3);
  });

  it('buildReminderEmailHtml still escapes the event name (regression guard)', () => {
    const html = buildReminderEmailHtml(HOSTILE_NAME, [day()], null, null, 'https://example.test/rsvp?token=abc');

    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_NAME);
  });
});
