import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import type { PrismaPg as PrismaPgType } from '@prisma/adapter-pg';
import type { Pool as PgPoolType } from 'pg';
import dotenv from 'dotenv';
import { resolveDatabaseUrl } from './resolve-database-url.util.js';

dotenv.config();

// ─────────────────────────────────────────
//  Resolve the correct database URL
//  based on the current NODE_ENV.
//
//  The actual resolution logic (including the DATABASE_URL_TEST
//  isolation guard) lives in resolve-database-url.util.ts, kept free of
//  dotenv/Prisma side effects so it can be unit-tested directly — see
//  tests/auth/db-guard.test.ts and that file's own header comment. This
//  call — and therefore the guard inside it — runs UNCONDITIONALLY,
//  before either adapter branch below, regardless of which one is
//  eventually chosen.
// ─────────────────────────────────────────

const getDatabaseUrl = (): string => resolveDatabaseUrl({ prod: 'DATABASE_URL_PROD', dev: 'DATABASE_URL_DEV' });

// ─────────────────────────────────────────
//  ADAPTER SELECTION
//
//  Tried and reverted (Auth Test Harness batch): routing NODE_ENV=test
//  through PrismaNeonHttp, to work around this environment's Neon
//  WebSocket occasionally being closed mid-query and Prisma/Neon's
//  reconnect handling hanging (minutes to multiple hours) rather than
//  failing fast. Reverted because Prisma 7's engine wraps more than
//  explicit prisma.$transaction(...) calls in a transaction internally,
//  and PrismaNeonHttp rejects ANY transaction outright.
//
//  This batch's fix: a plain TCP connection via @prisma/adapter-pg (node's
//  standard `pg` driver) instead of Neon's WebSocket driver, for tests
//  only. TCP supports transactions (unlike HTTP mode) and does not share
//  whatever this environment's WebSocket path was doing to drop
//  connections mid-query. The Neon test branch is on the Free plan,
//  which suspends compute after a few minutes idle — the pg Pool below
//  is configured to reconnect cleanly when that happens (see its own
//  comment), rather than to avoid it.
//
//  THE SWITCH ITSELF — PRISMA_TEST_ADAPTER — is a variable this file
//  checks but NEVER sets. The only place that ever sets it is tests/
//  setup.ts (a Vitest setupFile, guaranteed to run before any test
//  file's own imports resolve). It does not appear in .env, in
//  prisma.config.ts, in package.json's scripts, or anywhere `npm run
//  dev`/`npm start`/`node dist/server.js` touches. That means:
//
//    - `npm run dev`, `npm start`, and production ALWAYS take the
//      PrismaNeon branch below — the exact same construction call,
//      same arguments, as before this batch. Zero code path change for
//      them: the variable they'd need to reach the other branch is
//      never defined in their process at all, not "defined but false".
//    - The pg branch is additionally gated on NODE_ENV === 'test' too
//      (not just the flag alone) — belt and suspenders, so a stray
//      PRISMA_TEST_ADAPTER value leaking into a non-test process
//      (accidentally exported in a shell profile, say) still can't
//      flip a dev/prod process onto the test adapter by itself.
// ─────────────────────────────────────────

const useTestAdapter = process.env.NODE_ENV === 'test' && process.env.PRISMA_TEST_ADAPTER === 'pg';

// `pg` and `@prisma/adapter-pg` are devDependencies — test-only on
// purpose, so a production install (which typically omits devDependencies)
// is never made to depend on them. A plain `import` of either at the top
// of this file would defeat that: ESM static imports are resolved eagerly,
// so the module would fail to load in production the moment it's missing
// from node_modules, even though the code path that would actually use it
// never runs there. createRequire + a plain `require()`, guarded behind
// useTestAdapter, is loaded ONLY when that condition is true — in every
// dev/prod process it is never called at all, so those two packages being
// absent is a non-issue for them. (Only the TYPES are imported normally
// above, via `import type` — those are erased entirely at compile time,
// so they carry no runtime dependency either.)
const require = createRequire(import.meta.url);

// Small pool — this is a single largely-sequential test process, not a
// production workload. idleTimeoutMillis is short (10s) so a client that
// sat idle between test files is proactively closed and reconnected
// fresh, rather than reused after Neon's Free-tier compute may have
// suspended underneath it — a fresh TCP connection is exactly what wakes
// a suspended Neon compute back up (confirmed directly: a cold first
// query after idling takes ~2.5s, then normal). connectionTimeoutMillis
// bounds how long establishing a NEW connection may take before pg
// itself gives up with a clear error — generous enough for that cold
// start, bounded enough that a genuinely broken connection fails in
// seconds, not the multi-hour hangs the WebSocket adapter produced.
// Closed in test teardown (tests/setup.ts's afterAll) so Vitest exits by
// itself instead of hanging on an open handle.
export const testPgPool: PgPoolType | null = useTestAdapter
  ? new (require('pg').Pool)({
      connectionString: getDatabaseUrl(),
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
    })
  : null;

// ─────────────────────────────────────────
//  Prisma Client Singleton
//
//  Prisma 7 requires the database adapter
//  to be passed directly to the constructor.
//  We use PrismaNeon (Neon's serverless WebSocket driver) for dev/prod,
//  and — only under the switch above — PrismaPg (plain TCP) for tests.
//
//  The globalThis pattern prevents multiple
//  instances during hot reloads in dev.
// ─────────────────────────────────────────

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// disposeExternalPool: true — WITHOUT this, PrismaPg's dispose() (which
// prisma.$disconnect() triggers) only detaches its error listener from an
// externally-supplied pool and leaves it open, on the assumption that the
// caller who built the pool also owns closing it. This IS that caller: it
// built testPgPool above specifically to be owned and closed here, so
// $disconnect() (already called in every test file's own afterAll) must
// actually end it — otherwise the open TCP handles are exactly what
// leaves Vitest hanging after the tests themselves finish.
const adapter =
  useTestAdapter && testPgPool
    ? new (require('@prisma/adapter-pg').PrismaPg as typeof PrismaPgType)(testPgPool, { disposeExternalPool: true })
    : new PrismaNeon({ connectionString: getDatabaseUrl() });

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;