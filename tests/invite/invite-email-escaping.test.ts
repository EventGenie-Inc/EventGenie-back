import { describe, it, expect } from 'vitest';
import { buildInviteEmail, buildReminderEmail, type InviteEmailInput } from '../../src/modules/invite/invite-message.util.js';

// ─────────────────────────────────────────
//  SECURITY SWEEP BEFORE G3 — FIX 3
//
//  An organiser-typed event name reaches a guest's inbox verbatim today
//  unless escaped — buildInviteEmailHtml did not; buildReminderEmailHtml
//  already did. Escaping now lives in the shared layout (email-layout.ts),
//  which the builders hand plain text; this guards the same promise.
// ─────────────────────────────────────────

const HOSTILE_NAME = `<script>alert(1)</script> "&'`;
const ESCAPED_NAME = '&lt;script&gt;alert(1)&lt;/script&gt; &quot;&amp;&#39;';

// The venue belongs to each event day, so the builders take the guest's
// invited days (label, date, venue name, address).
const day = (over: Partial<{ label: string; location: string; address: string }> = {}) => ({
  label: 'Day 1', date: new Date('2027-01-01'), location: 'Some Venue', address: '1 Road', ...over,
});

const html = (
  build: (input: InviteEmailInput) => { html: string },
  eventName: string,
  days: ReturnType<typeof day>[]
): string =>
  build({
    eventName,
    hostName: null,
    days,
    fallbackDateLabel: null,
    rsvpDeadline: null,
    rsvpLink: 'https://example.test/rsvp?token=abc',
    design: null,
    organiserEmail: null,
  }).html;

describe('invite/reminder email HTML — organiser-typed values are escaped', () => {
  it('buildInviteEmail renders the event name escaped, not as live markup', () => {
    const out = html(buildInviteEmail, HOSTILE_NAME, [day()]);

    expect(out).not.toContain(HOSTILE_NAME);
    expect(out).not.toContain('<script>');
    expect(out).toContain(ESCAPED_NAME);
  });

  it('buildInviteEmail renders the venue escaped too — single day', () => {
    const out = html(buildInviteEmail, 'Some Event', [day({ location: HOSTILE_NAME })]);

    expect(out).not.toContain('<script>');
    expect(out).toContain(ESCAPED_NAME);
  });

  it('buildInviteEmail escapes every day line — label, venue and address — for multi-day invites', () => {
    const out = html(buildInviteEmail, 'Some Event', [day({ label: HOSTILE_NAME }), day({ label: 'Day 2', address: HOSTILE_NAME })]);

    expect(out).not.toContain('<script>');
    expect(out.split(ESCAPED_NAME)).toHaveLength(3);
  });

  it('buildReminderEmail still escapes the event name (regression guard)', () => {
    const out = html(buildReminderEmail, HOSTILE_NAME, [day()]);

    expect(out).not.toContain('<script>');
    expect(out).toContain(ESCAPED_NAME);
  });
});
