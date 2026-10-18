import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { publicRegistrationEmailKey } from '../../src/shared/middleware/rate-limit.middleware.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, freshEmail, freshIp, prisma } from './helpers.js';

// ─────────────────────────────────────────
//  REGISTRATION RATE LIMITS — per IP and per email
//
//  Per email (5 / hour, keyed by the hash of the NORMALISED address):
//  registering an address that's already on the list re-sends its link,
//  so without this anyone could flood someone's inbox from many IPs.
//  Per IP (30 / 15 minutes): raised from 8 so an office of colleagues on
//  one network can register, still bounding one machine's script.
//  This file gets its own limiter instances (Vitest isolates each file's
//  modules), so nothing here shares a budget with another file.
// ─────────────────────────────────────────

afterEach(cleanupPublicEventFixtures);

describe('publicRegistrationEmailKey', () => {
  it('is the hash of the normalised email, never the address', () => {
    const key = publicRegistrationEmailKey({ email: '  Thandi@Example.TEST ' }, '1.2.3.4');
    expect(key).toMatch(/^register-email:[0-9a-f]{64}$/);
    expect(key).not.toMatch(/thandi|example/i);
    expect(publicRegistrationEmailKey({ email: 'thandi@example.test' }, '5.6.7.8')).toBe(key);
  });

  it('falls back to the IP when there is no email', () => {
    expect(publicRegistrationEmailKey({}, '1.2.3.4')).toBe(publicRegistrationEmailKey({ email: '  ' }, '1.2.3.4'));
    expect(publicRegistrationEmailKey({}, '1.2.3.4')).not.toBe(publicRegistrationEmailKey({}, '9.9.9.9'));
  });
});

describe('per email', () => {
  it('the 6th request in an hour for one address is refused, from any IP and any casing; another address is unaffected', async () => {
    const ev = await createPublicEvent();
    const email = freshEmail();
    for (let i = 1; i <= 5; i++) {
      const res = await register(ev.shareToken, { email: i % 2 ? email.toUpperCase() : email });
      // A repeat is answered exactly as a new registration (201).
      expect(res.status, `attempt ${i}`).toBe(201);
    }
    const sixth = await register(ev.shareToken, { email: `  ${email} ` });
    expect(sixth.status).toBe(429);
    expect(sixth.body.message).toBe('Too many registration attempts for this email address. Please wait a while and try again.');

    expect((await register(ev.shareToken, { email: freshEmail() })).status).toBe(201);
    expect(await prisma.guest.count({ where: { eventId: ev.eventId } })).toBe(2);
  }, 120000);
});

describe('per IP', () => {
  it('30 requests in 15 minutes from one IP, then refused; another IP is unaffected', async () => {
    const ip = freshIp();
    // Unknown share tokens (a 404 each, no fixtures) and fresh emails, so
    // only the IP limiter is ever the one counting toward a limit.
    for (let i = 1; i <= 30; i++) {
      const res = await register(`no-such-${randomUUID()}`, { email: freshEmail() }, ip);
      expect(res.status, `attempt ${i}`).toBe(404);
    }
    const refused = await register(`no-such-${randomUUID()}`, { email: freshEmail() }, ip);
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe('Too many registration attempts. Please wait a few minutes and try again.');

    expect((await register(`no-such-${randomUUID()}`, { email: freshEmail() })).status).toBe(404);
  }, 300000);
});
