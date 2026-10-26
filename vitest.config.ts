import { defineConfig } from 'vitest/config';

// ─────────────────────────────────────────
//  Auth Test Harness batch — the smallest useful Vitest setup.
//
//  environment: 'node' — this is an HTTP-level backend suite (supertest
//  against the real Express app), not a browser/DOM suite.
//
//  setupFiles: tests/setup.ts mocks firebase-admin/auth (the ONE
//  boundary — see that file's own header) before any test file's own
//  imports run, and forces NODE_ENV=test so src/shared/prisma/
//  prisma.client.ts and prisma.config.ts route to DATABASE_URL_TEST
//  rather than the shared dev database.
//
//  No coverage config, no reporters beyond the default — nothing here
//  that isn't needed to run the auth guard suite.
// ─────────────────────────────────────────
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Auth tests share one real Postgres connection (the test database).
    // Running test files sequentially (not in parallel) keeps this first
    // suite simple and avoids any risk of Prisma connection-pool
    // exhaustion against a small Neon branch. Revisit if the suite grows
    // large enough for this to matter.
    fileParallelism: false,
    // A hung test or hook fails in seconds, never hours. These apply to
    // every test and hook that doesn't set its own; the default ones are
    // small, and 30s covers the worst ordinary wait: waking the idle Neon
    // test branch (the pool's 15s connect timeout, then ~2.5s for the first
    // query). A test or hook that needs longer passes its own timeout, at
    // most 3 minutes outside tests/perf/ (the slowest, the rate-limit tests,
    // take ~70s). tests/perf/ is opt-in and sets its own. A stalled query
    // fails sooner still, through query_timeout (tests/setup.ts).
    // Nothing here can fire while the machine sleeps: timers stop. A full
    // run needs the machine kept awake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
