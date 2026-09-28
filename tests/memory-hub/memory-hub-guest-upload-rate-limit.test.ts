import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { memoryHubGuestUploadTokenKey } from '../../src/shared/middleware/rate-limit.middleware.js';

// ─────────────────────────────────────────
//  GUEST UPLOAD LIMITS — Part 1
//
//  memoryHubGuestUploadLimiter used to be keyed purely by IP (20/5min),
//  which meant an entire event sharing one venue WiFi or one South
//  African carrier-grade NAT IP shared a single ~10-photos-per-5-minute
//  budget across every guest — nothing to do with abuse. Now keyed by
//  the SHA-256 hash of the invite TOKEN (60/5min per invite), with a
//  separate, generous per-IP abuse backstop counting only failures
//  (memoryHubGuestUploadIpLimiter, 100/5min).
//
//  HTTP-level via supertest against the real app, same pattern as
//  tests/auth/rate-limit.test.ts — this file gets its own fresh
//  rate-limiter instances (Vitest isolates each test file's module
//  registry), so nothing here shares a budget with any other file.
//  Fake, never-valid invite tokens are used throughout: the limiter
//  fires (or doesn't) purely on request count for its key, regardless
//  of whether the route handler's own business logic would accept the
//  token — a 404 from an unknown token is itself a normal "failed
//  attempt" for these purposes, and no real Invite/Guest/Event fixture
//  is needed to prove budget separation or the key format.
// ─────────────────────────────────────────

describe('memoryHubGuestUploadTokenKey', () => {
  it('never contains the raw invite token — it is the hashed value', () => {
    const raw = 'a'.repeat(64);
    const key = memoryHubGuestUploadTokenKey(raw);
    expect(key).not.toContain(raw);
    expect(key).toMatch(/^memory-hub-invite:[0-9a-f]{64}$/); // sha256 hex digest, 64 chars
  });

  it('is deterministic — the same raw token always produces the same key', () => {
    const raw = 'b'.repeat(64);
    expect(memoryHubGuestUploadTokenKey(raw)).toBe(memoryHubGuestUploadTokenKey(raw));
  });

  it('produces different keys for different tokens', () => {
    expect(memoryHubGuestUploadTokenKey('c'.repeat(64))).not.toBe(memoryHubGuestUploadTokenKey('d'.repeat(64)));
  });
});

describe('memoryHubGuestUploadLimiter — per-invite budget, not per IP', () => {
  it(
    "two different invite tokens from the SAME IP each get their own budget — exhausting one never limits the other",
    async () => {
      const tokenA = 'rate-limit-test-token-a-' + 'x'.repeat(40);
      const tokenB = 'rate-limit-test-token-b-' + 'y'.repeat(40);

      // Exhaust tokenA's budget (max 60) — every request here goes
      // through the real Express app (supertest, all from the same
      // loopback IP), so this also exercises the per-IP backstop
      // sitting in front of it without tripping it (max 100, failures
      // only — 61 requests is comfortably under that).
      let sawTokenA429 = false;
      for (let i = 1; i <= 65; i++) {
        const res = await request(app)
          .post('/api/memory-hub/guest-upload-signature')
          .send({ token: tokenA, mediaType: 'IMAGE' });
        if (res.status === 429) {
          sawTokenA429 = true;
          expect(res.body.message).toMatch(/upload requests/i);
          break;
        }
        // Every attempt here is a genuine "invalid token" 404 — proves
        // nothing about the limiter, just confirms it's really
        // exercising the endpoint and not silently short-circuiting.
        expect(res.status).toBe(404);
      }
      expect(sawTokenA429).toBe(true);

      // tokenB, same IP, same run — must NOT be limited: it has never
      // been sent before, so its own per-invite budget is untouched
      // regardless of how many requests tokenA (or the shared IP) made.
      const resB = await request(app)
        .post('/api/memory-hub/guest-upload-signature')
        .send({ token: tokenB, mediaType: 'IMAGE' });
      expect(resB.status).toBe(404); // invalid token, but NOT 429
    },
    30000
  );
});
