import { describe, it, expect, afterEach, vi } from 'vitest';

// ─────────────────────────────────────────
//  RATE-LIMIT KEYS — every custom keyGenerator that falls back to the
//  request IP goes through express-rate-limit's ipKeyGenerator, so an IPv6
//  visitor can't step around a limit by moving within their own /56. The
//  library checks each keyGenerator's source when the limiter is created
//  and logs ERR_ERL_KEY_GEN_IPV6 otherwise; loading the limiters must log
//  nothing.
// ─────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading the rate limiters', () => {
  it('logs no ERR_ERL_KEY_GEN_IPV6 (or any other express-rate-limit validation error)', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args); });
    vi.resetModules();
    await import('../../src/shared/middleware/rate-limit.middleware.js');
    const text = logged.map((args) => args.map((a) => (a instanceof Error ? `${(a as { code?: string }).code} ${a.message}` : String(a))).join(' '));
    expect(text.filter((t) => /ERR_ERL_|keyGenerator/.test(t))).toEqual([]);
  });
});
