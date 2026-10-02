import 'dotenv/config';
import { execFileSync } from 'child_process';
import { assertDatabaseUrlIsolated } from '../src/shared/prisma/database-url-guard.util.js';

// ─────────────────────────────────────────
//  GUARDED TEST-DATABASE RESET
//
//  `prisma migrate reset --force` drops every table and reapplies every
//  migration from scratch — the right tool for a schema-only Neon
//  branch whose _prisma_migrations table is empty (plain `migrate
//  deploy` fails there: the tables already exist, so it tries to CREATE
//  them again). It is also completely unrecoverable, and dev and prod
//  currently share ONE Neon endpoint (see prisma.client.ts's own
//  comment) — pointed at the wrong URL, this drops production.
//
//  The guard therefore runs HERE, explicitly, before this script ever
//  invokes the Prisma CLI — not relying solely on prisma.config.ts's
//  own internal check (which still runs too, as a second, independent
//  layer, exactly the belt-and-suspenders shape this batch's report
//  argues for). If this script's own check does not pass, `prisma
//  migrate reset` is never spawned at all.
//
//  Never logs DATABASE_URL_TEST or any other connection string, on
//  either success or failure.
// ─────────────────────────────────────────

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  console.error('DATABASE_URL_TEST is not defined in .env. Refusing to reset anything.');
  process.exit(1);
}

try {
  assertDatabaseUrlIsolated(testUrl, {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_DEV: process.env.DATABASE_URL_DEV,
    DATABASE_URL_DEV_DIRECT: process.env.DATABASE_URL_DEV_DIRECT,
    DATABASE_URL_PROD: process.env.DATABASE_URL_PROD,
    DATABASE_URL_PROD_DIRECT: process.env.DATABASE_URL_PROD_DIRECT,
  });
} catch (error) {
  console.error((error as Error).message);
  console.error('Refusing to run `prisma migrate reset` — the isolation guard above did not pass.');
  process.exit(1);
}

console.log('Guard passed: DATABASE_URL_TEST is isolated from every known dev/prod database URL.');
console.log('Resetting the test database (drop + reapply all migrations)...');

// --skip-seed is not a recognised flag on this Prisma CLI version's
// `migrate reset` (confirmed against its own --help output) — harmless
// either way, since neither package.json nor prisma.config.ts configures
// a seed command for `migrate reset` to run.
execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});

console.log('Test database reset complete.');
