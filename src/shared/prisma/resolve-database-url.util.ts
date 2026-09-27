import { assertDatabaseUrlIsolated } from './database-url-guard.util.js';

// ─────────────────────────────────────────
//  Pure URL-resolution logic — no dotenv, no Prisma/Neon adapter
//  construction. Deliberately separated out of prisma.client.ts/
//  prisma.config.ts (which both call this) so it can be exercised
//  directly and repeatedly in tests by mutating process.env and calling
//  again — re-importing prisma.client.ts itself re-runs `dotenv.config()`
//  and reconstructs a real PrismaNeon adapter on every fresh module
//  evaluation, which is both slower and, in this environment, actively
//  broken: repeated dotenv.config() calls across `vi.resetModules()` +
//  dynamic re-import cycles overflow the call stack (this environment's
//  dotenv is wrapped by an env-injection layer visible in every command's
//  "injected env ... tip" banner — not something this codebase controls
//  or should need to work around by avoiding a legitimate test pattern).
//
//  envNames lets prisma.client.ts (pooled DATABASE_URL_DEV/_PROD) and
//  prisma.config.ts (direct DATABASE_URL_DEV_DIRECT/_PROD_DIRECT) share
//  this one implementation of the 'test' branch — the only branch with
//  real logic (the isolation guard) worth keeping in exactly one place —
//  while each still resolves its own correct pair of dev/prod variables.
// ─────────────────────────────────────────

export interface DatabaseUrlEnvNames {
  prod: 'DATABASE_URL_PROD' | 'DATABASE_URL_PROD_DIRECT';
  dev: 'DATABASE_URL_DEV' | 'DATABASE_URL_DEV_DIRECT';
}

export const resolveDatabaseUrl = (envNames: DatabaseUrlEnvNames): string => {
  const env = process.env.NODE_ENV ?? 'development';

  if (env === 'production') {
    const url = process.env[envNames.prod];
    if (!url) throw new Error(`${envNames.prod} is not defined in .env`);
    return url;
  }

  // Auth Test Harness batch — NODE_ENV=test is set only by the Vitest
  // suite (vitest.config.ts) and the guarded reset script (scripts/
  // reset-test-database.ts). Dev and prod currently share one Neon
  // endpoint, so the ONLY thing standing between an automated test run
  // (or a `prisma migrate reset --force`) and writing to or wiping real
  // tenant data is this branch actually refusing to fall through.
  // Enforced here, at the exact point the URL is chosen.
  if (env === 'test') {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) {
      throw new Error(
        'DATABASE_URL_TEST is not defined in .env. Refusing to run with NODE_ENV=test — ' +
        'there is no safe fallback here, unlike development/production.'
      );
    }
    assertDatabaseUrlIsolated(url, {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_DEV: process.env.DATABASE_URL_DEV,
      DATABASE_URL_DEV_DIRECT: process.env.DATABASE_URL_DEV_DIRECT,
      DATABASE_URL_PROD: process.env.DATABASE_URL_PROD,
      DATABASE_URL_PROD_DIRECT: process.env.DATABASE_URL_PROD_DIRECT,
    });
    return url;
  }

  const url = process.env[envNames.dev];
  if (!url) throw new Error(`${envNames.dev} is not defined in .env`);
  return url;
};
