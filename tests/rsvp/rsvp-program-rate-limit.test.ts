import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import {
  RSVP_PROGRAM_VIEWS_PER_INVITE_PER_5_MIN,
  rsvpProgramInviteKey,
} from '../../src/shared/middleware/rate-limit.middleware.js';

// ─────────────────────────────────────────
//  GUEST PROGRAM LIMITS
//
//  POST /api/rsvp/program fires when a guest opens their page, and at the
//  event that is a whole room on one Wi-Fi network (one IP) at once. It
//  used to be keyed by IP (60/5min), so the 61st guest's Program tab
//  failed to load. Now keyed by the SHA-256 of the invite token (60/5min
//  per invite), with a per-IP backstop counting only failures (100/5min).
//
//  Same approach as memory-hub-guest-view-rate-limit.test.ts: made-up
//  tokens throughout (each a 404, which the limiters count like any other
//  request), all from supertest's one loopback IP. This file gets its own
//  limiter instances, and its tests run in sequence, so the counts below
//  carry from one test to the next.
// ─────────────────────────────────────────

const program = (token: string) => request(app).post('/api/rsvp/program').send({ token });
const madeUp = (label: string) => `rsvp-program-rate-limit-${label}-${'q'.repeat(40)}`;

describe('rsvpProgramInviteKey', () => {
  it('is the hashed token, never the raw one, and differs per token', () => {
    const raw = 'g'.repeat(64);
    expect(rsvpProgramInviteKey(raw)).not.toContain(raw);
    expect(rsvpProgramInviteKey(raw)).toMatch(/^rsvp-program-invite:[0-9a-f]{64}$/);
    expect(rsvpProgramInviteKey(raw)).toBe(rsvpProgramInviteKey(raw));
    expect(rsvpProgramInviteKey('h'.repeat(64))).not.toBe(rsvpProgramInviteKey(raw));
  });
});

describe('rsvpProgramLimiter — per invite, not per IP', () => {
  it('one invite is refused past its budget, and another invite on the same IP still is not', async () => {
    const tokenA = madeUp('a');
    for (let i = 1; i <= RSVP_PROGRAM_VIEWS_PER_INVITE_PER_5_MIN; i++) {
      const res = await program(tokenA);
      expect(res.status).toBe(404);
    }
    const refused = await program(tokenA);
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe('Too many requests. Please wait a few minutes and try again.');

    // Another guest in the same room: same IP, its own budget.
    const other = await program(madeUp('b'));
    expect(other.status).toBe(404);
  }, 120000);
});

describe('rsvpProgramIpLimiter — the backstop against a made-up token per request', () => {
  it('refuses an IP after 100 failed requests, whatever the tokens', async () => {
    // 62 failures so far in this file (60 + the 429 + the other invite).
    let refusedAt: number | null = null;
    for (let i = 1; i <= 60 && refusedAt === null; i++) {
      const res = await program(madeUp(`fresh-${i}`));
      if (res.status === 429) {
        expect(res.body.message).toBe('Too many requests from this network. Please wait a few minutes and try again.');
        refusedAt = i;
      } else {
        expect(res.status).toBe(404);
      }
    }
    expect(refusedAt).toBe(100 - 62 + 1);
  }, 120000);
});
