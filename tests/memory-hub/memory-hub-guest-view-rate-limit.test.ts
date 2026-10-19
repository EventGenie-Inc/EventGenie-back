import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import {
  MEMORY_HUB_GUEST_VIEWS_PER_INVITE_PER_5_MIN,
  memoryHubGuestViewInviteKey,
} from '../../src/shared/middleware/rate-limit.middleware.js';

// ─────────────────────────────────────────
//  GUEST VIEW LIMITS
//
//  POST /api/memory-hub/guest-view fires when a guest opens their page, and
//  at the event that is a whole room on one Wi-Fi network (one IP) at once.
//  It used to be keyed by IP (60/5min), so the 61st guest's photo tab
//  failed to load. Now keyed by the SHA-256 of the invite token (60/5min
//  per invite), with a per-IP backstop counting only failures (100/5min).
//
//  Same approach as memory-hub-guest-upload-rate-limit.test.ts: made-up
//  tokens throughout (each a 404, which the limiters count like any other
//  request), all from supertest's one loopback IP. This file gets its own
//  limiter instances (Vitest isolates each file's modules), so the
//  requests below are counted in order: tests run in sequence.
// ─────────────────────────────────────────

const guestView = (token: string) => request(app).post('/api/memory-hub/guest-view').send({ token });
const madeUp = (label: string) => `guest-view-rate-limit-${label}-${'z'.repeat(40)}`;

describe('memoryHubGuestViewInviteKey', () => {
  it('is the hashed token, never the raw one, and differs per token', () => {
    const raw = 'e'.repeat(64);
    expect(memoryHubGuestViewInviteKey(raw)).not.toContain(raw);
    expect(memoryHubGuestViewInviteKey(raw)).toMatch(/^memory-hub-view-invite:[0-9a-f]{64}$/);
    expect(memoryHubGuestViewInviteKey(raw)).toBe(memoryHubGuestViewInviteKey(raw));
    expect(memoryHubGuestViewInviteKey('f'.repeat(64))).not.toBe(memoryHubGuestViewInviteKey(raw));
  });
});

describe('memoryHubGuestViewLimiter — per invite, not per IP', () => {
  it('one invite is refused past its budget, and another invite on the same IP still is not', async () => {
    const tokenA = madeUp('a');
    for (let i = 1; i <= MEMORY_HUB_GUEST_VIEWS_PER_INVITE_PER_5_MIN; i++) {
      const res = await guestView(tokenA);
      expect(res.status).toBe(404);
    }
    const refused = await guestView(tokenA);
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe('Too many requests. Please wait a few minutes and try again.');

    // Another guest in the same room: same IP, its own budget.
    const other = await guestView(madeUp('b'));
    expect(other.status).toBe(404);
  }, 120000);
});

describe('memoryHubGuestViewIpLimiter — the backstop against a made-up token per request', () => {
  it('refuses an IP after 100 failed requests, whatever the tokens', async () => {
    // 62 failures so far in this file (60 + the 429 + the other invite).
    let refusedAt: number | null = null;
    for (let i = 1; i <= 60 && refusedAt === null; i++) {
      const res = await guestView(madeUp(`fresh-${i}`));
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
