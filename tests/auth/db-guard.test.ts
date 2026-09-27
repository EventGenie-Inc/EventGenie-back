import { describe, it, expect, afterEach } from 'vitest';
import dotenv from 'dotenv';
import { normalizeDatabaseHost, assertDatabaseUrlIsolated } from '../../src/shared/prisma/database-url-guard.util.js';
import { resolveDatabaseUrl } from '../../src/shared/prisma/resolve-database-url.util.js';

// resolveDatabaseUrl is deliberately dotenv-free (see its own header
// comment), so — exactly like prisma.client.ts/prisma.config.ts, which
// both call dotenv.config() once before ever calling it — this file
// loads .env itself, once, at module load. NOT repeated per test: a
// SINGLE plain call here is safe; what actually overflowed the stack
// earlier was re-triggering dotenv.config() repeatedly via
// vi.resetModules() + dynamic re-import cycles (see the removed
// approach in this file's git history / the batch report).
dotenv.config();

// ─────────────────────────────────────────
//  Pure-function tests — no real database connection, just string
//  handling. These are what actually prove the pooled-vs-direct Neon
//  case: a `-pooler` hostname and its non-pooled counterpart for the
//  SAME endpoint id must compare equal, while genuinely different
//  endpoints (a real separate database, which is what DATABASE_URL_TEST
//  actually is) must not.
// ─────────────────────────────────────────
describe('normalizeDatabaseHost / assertDatabaseUrlIsolated', () => {
  const DIRECT = 'postgresql://user:pass@ep-cool-forest-12345678.us-east-2.aws.neon.tech/db';
  const POOLED_SAME_ENDPOINT = 'postgresql://user:pass@ep-cool-forest-12345678-pooler.us-east-2.aws.neon.tech/db';
  const DIFFERENT_ENDPOINT = 'postgresql://user:pass@ep-different-lake-87654321.us-east-2.aws.neon.tech/db';
  const LOCALHOST = 'postgresql://user:pass@localhost:5432/db';

  it('normalises a pooled and a direct URL for the same Neon endpoint to the same host', () => {
    expect(normalizeDatabaseHost(POOLED_SAME_ENDPOINT)).toBe(normalizeDatabaseHost(DIRECT));
  });

  it('does not conflate two genuinely different Neon endpoints', () => {
    expect(normalizeDatabaseHost(DIFFERENT_ENDPOINT)).not.toBe(normalizeDatabaseHost(DIRECT));
  });

  it('refuses a pooled test URL against a direct dev URL for the SAME endpoint', () => {
    expect(() =>
      assertDatabaseUrlIsolated(POOLED_SAME_ENDPOINT, { DATABASE_URL_DEV_DIRECT: DIRECT })
    ).toThrow(/DATABASE_URL_DEV_DIRECT/);
  });

  it('refuses a direct test URL against a pooled dev URL for the SAME endpoint (the reverse pairing)', () => {
    expect(() =>
      assertDatabaseUrlIsolated(DIRECT, { DATABASE_URL_DEV: POOLED_SAME_ENDPOINT })
    ).toThrow(/DATABASE_URL_DEV/);
  });

  it('allows a genuinely different endpoint through', () => {
    expect(() =>
      assertDatabaseUrlIsolated(DIFFERENT_ENDPOINT, { DATABASE_URL_DEV: DIRECT, DATABASE_URL_DEV_DIRECT: POOLED_SAME_ENDPOINT })
    ).not.toThrow();
  });

  it('always allows localhost through, even if a compared URL happens to match', () => {
    expect(() => assertDatabaseUrlIsolated(LOCALHOST, { DATABASE_URL_DEV: LOCALHOST })).not.toThrow();
  });

  it('skips unset comparison entries rather than treating them as a match', () => {
    expect(() =>
      assertDatabaseUrlIsolated(DIFFERENT_ENDPOINT, { DATABASE_URL_PROD: undefined })
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────
//  Proves the refusal end to end through the SAME function
//  prisma.client.ts/prisma.config.ts actually call — resolveDatabaseUrl
//  — rather than re-importing prisma.client.ts itself. That module calls
//  dotenv.config() and constructs a real PrismaNeon adapter on every
//  fresh module evaluation; repeatedly re-triggering that via
//  vi.resetModules() + dynamic re-import is unnecessary here (none of
//  that side-effecting code is what's under test) and, in this
//  environment specifically, overflows the call stack — this sandbox's
//  dotenv is wrapped by an env-injection layer (visible as the
//  "injected env ... tip" banner on every command in this session), and
//  calling it repeatedly within one process via reset+reimport cycles
//  breaks it. resolveDatabaseUrl has no dotenv/adapter side effects at
//  all, so it is safe to call directly and repeatedly.
// ─────────────────────────────────────────
describe('DATABASE_URL_TEST safety guard (resolveDatabaseUrl, NODE_ENV=test)', () => {
  const original = {
    DATABASE_URL_TEST: process.env.DATABASE_URL_TEST,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_DEV: process.env.DATABASE_URL_DEV,
  };

  const ENV_NAMES = { prod: 'DATABASE_URL_PROD', dev: 'DATABASE_URL_DEV' } as const;

  afterEach(() => {
    process.env.DATABASE_URL_TEST = original.DATABASE_URL_TEST;
    process.env.DATABASE_URL = original.DATABASE_URL;
    process.env.DATABASE_URL_DEV = original.DATABASE_URL_DEV;
  });

  it('refuses to run when DATABASE_URL_TEST is unset', () => {
    delete process.env.DATABASE_URL_TEST;
    expect(() => resolveDatabaseUrl(ENV_NAMES)).toThrow(/DATABASE_URL_TEST is not defined/);
  });

  it('refuses to run when DATABASE_URL_TEST equals DATABASE_URL', () => {
    process.env.DATABASE_URL_TEST = process.env.DATABASE_URL;
    expect(() => resolveDatabaseUrl(ENV_NAMES)).toThrow(/resolves to the same database/);
  });

  it('refuses to run when DATABASE_URL_TEST equals DATABASE_URL_DEV', () => {
    process.env.DATABASE_URL_TEST = process.env.DATABASE_URL_DEV;
    expect(() => resolveDatabaseUrl(ENV_NAMES)).toThrow(/resolves to the same database/);
  });

  it('does not throw when DATABASE_URL_TEST is set and distinct (sanity check)', () => {
    // original.DATABASE_URL_TEST is exactly what the rest of the suite
    // already runs against successfully — this just confirms the guard
    // is not accidentally throwing on the valid case too.
    expect(resolveDatabaseUrl(ENV_NAMES)).toBe(original.DATABASE_URL_TEST);
  });
});
