import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  PUBLIC_REGISTRATIONS_PER_EVENT_PER_5_MIN,
  PUBLIC_REGISTRATIONS_PER_IP_PER_15_MIN,
  publicRegistrationEmailKey,
} from '../../src/shared/middleware/rate-limit.middleware.js';
import { createPublicEvent, cleanupPublicEventFixtures, register, freshEmail, freshIp, prisma } from './helpers.js';

// ─────────────────────────────────────────
//  REGISTRATION RATE LIMITS — per IP, per email and per event
//
//  Per email (5 / hour, keyed by the hash of the NORMALISED address):
//  registering an address that's already on the list re-sends its link,
//  so without this anyone could flood someone's inbox from many IPs.
//  Per IP (500 / 15 minutes) and per event (300 / 5 minutes): sized for a
//  300-person office registering from one network in the first 15
//  minutes, ~450 requests front-loaded after one all-staff email, while
//  still bounding one machine's script and a distributed one's pace.
//  This file gets its own limiter instances (Vitest isolates each file's
//  modules), so nothing here shares a budget with another file.
//
//  Unknown share tokens (a 404 each, no fixtures) and fresh emails, so
//  only the limiter under test is ever the one counting toward a limit.
//  Sent in concurrent batches to keep the run short; each limiter counts
//  a request when it arrives, so the totals are exact.
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

// Sends `count` requests, `batch` at a time, and returns their statuses.
// 5 at a time, the test database pool's size (prisma.client.ts): more only
// queue for a connection, and on a slow moment past its 15-second wait
// they fail as 500s that have nothing to do with the limiters.
const inBatches = async (count: number, send: () => Promise<{ status: number }>, batch = 5) => {
  const statuses: number[] = [];
  for (let sent = 0; sent < count; sent += batch) {
    const results = await Promise.all(Array.from({ length: Math.min(batch, count - sent) }, send));
    statuses.push(...results.map((r) => r.status));
  }
  return statuses;
};

describe('per IP', () => {
  it('a 300-person office registering from one IP in 15 minutes (~450 requests) is never refused', async () => {
    const ip = freshIp();
    const statuses = await inBatches(450, () => register(`no-such-${randomUUID()}`, { email: freshEmail() }, ip));
    expect(statuses.filter((s) => s !== 404)).toEqual([]);
  }, 180000);

  it(`refused past ${PUBLIC_REGISTRATIONS_PER_IP_PER_15_MIN} in 15 minutes from one IP; another IP is unaffected`, async () => {
    const ip = freshIp();
    const statuses = await inBatches(PUBLIC_REGISTRATIONS_PER_IP_PER_15_MIN, () =>
      register(`no-such-${randomUUID()}`, { email: freshEmail() }, ip)
    );
    expect(statuses.filter((s) => s !== 404)).toEqual([]);
    const refused = await register(`no-such-${randomUUID()}`, { email: freshEmail() }, ip);
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe('Too many registration attempts. Please wait a few minutes and try again.');

    expect((await register(`no-such-${randomUUID()}`, { email: freshEmail() })).status).toBe(404);
  }, 180000);
});

describe('per event', () => {
  // Every request below on one link, each from its own IP (the default
  // freshIp), so only the per-event limiter counts toward a limit.
  it('the burst after one all-staff email (~180 requests in five minutes, ~90 a minute at the peak) is never refused', async () => {
    const link = `no-such-${randomUUID()}`;
    const statuses = await inBatches(180, () => register(link, { email: freshEmail() }));
    expect(statuses.filter((s) => s !== 404)).toEqual([]);
  }, 180000);

  it(`refused past ${PUBLIC_REGISTRATIONS_PER_EVENT_PER_5_MIN} in five minutes on one link, from any IPs; another link is unaffected`, async () => {
    const link = `no-such-${randomUUID()}`;
    const statuses = await inBatches(PUBLIC_REGISTRATIONS_PER_EVENT_PER_5_MIN, () => register(link, { email: freshEmail() }));
    expect(statuses.filter((s) => s !== 404)).toEqual([]);
    const refused = await register(link, { email: freshEmail() });
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe('Registration for this event is receiving a high volume of requests right now. Please try again in a moment.');

    expect((await register(`no-such-${randomUUID()}`, { email: freshEmail() })).status).toBe(404);
  }, 180000);
});
