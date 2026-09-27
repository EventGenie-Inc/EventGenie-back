import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
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
//  tests/auth/db-guard.test.ts and that file's own header comment.
// ─────────────────────────────────────────

const getDatabaseUrl = (): string => resolveDatabaseUrl({ prod: 'DATABASE_URL_PROD', dev: 'DATABASE_URL_DEV' });

// ─────────────────────────────────────────
//  Prisma Client Singleton
//
//  Prisma 7 requires the database adapter
//  to be passed directly to the constructor.
//  We use PrismaNeon for Neon's serverless
//  PostgreSQL connection pooling.
//
//  The globalThis pattern prevents multiple
//  instances during hot reloads in dev.
//
//  Tried and reverted (Auth Test Harness batch): routing NODE_ENV=test
//  through PrismaNeonHttp instead, to work around this environment's
//  Neon WebSocket occasionally being closed mid-query and Prisma/Neon's
//  reconnect handling hanging (minutes to multiple hours) rather than
//  failing fast. Reverted because Prisma 7's engine wraps more than
//  explicit prisma.$transaction(...) calls in a transaction internally,
//  and PrismaNeonHttp rejects ANY transaction outright — it broke plain
//  single-model writes (e.g. DeviceToken.updateMany via
//  device-token.repository.ts's revoke), not just the tenant.service.ts/
//  user.service.ts call sites that use $transaction explicitly. Not a
//  safe swap. See the batch report's "infrastructure flakiness" section
//  for how this was instead handled (rerun discipline, not a code
//  workaround) and prisma.config.ts for the equivalent test/migration
//  path, which was never changed.
// ─────────────────────────────────────────

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaNeon({ connectionString: getDatabaseUrl() });

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