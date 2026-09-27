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

describe('invite/reminder email HTML — organiser-typed values are escaped', () => {
  it('buildInviteEmailHtml renders the event name escaped, not as live markup', () => {
    const html = buildInviteEmailHtml(HOSTILE_NAME, 'Some Venue', null, 'https://example.test/rsvp?token=abc');

    expect(html).not.toContain(HOSTILE_NAME);
    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_NAME);
  });

  it('buildInviteEmailHtml renders the venue escaped too', () => {
    const html = buildInviteEmailHtml('Some Event', HOSTILE_NAME, null, 'https://example.test/rsvp?token=abc');

    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_NAME);
  });

  it('buildReminderEmailHtml still escapes the event name (regression guard)', () => {
    const html = buildReminderEmailHtml(HOSTILE_NAME, 'Some Venue', null, null, 'https://example.test/rsvp?token=abc');

    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_NAME);
  });
});
