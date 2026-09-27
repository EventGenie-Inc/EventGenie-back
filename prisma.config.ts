import { defineConfig } from 'prisma/config';
import dotenv from 'dotenv';
import { resolveDatabaseUrl } from './src/shared/prisma/resolve-database-url.util.js';

dotenv.config();

// Auth Test Harness batch — lets `NODE_ENV=test npx prisma migrate
// deploy` (and the guarded reset script, scripts/reset-test-database.ts)
// apply migrations to the separate test database. The 'test' branch's
// isolation guard is shared with src/shared/prisma/prisma.client.ts via
// resolve-database-url.util.ts — this is the datasource `prisma migrate
// reset --force` itself reads, so it is what stands between a
// misconfigured NODE_ENV=test and a wiped shared database (dev and prod
// currently share one Neon endpoint). No pooled/direct split for test
// the way dev/prod have — one Neon branch connection string serves both
// migrations and runtime queries here; simpler, and the pooling concern
// that split exists for doesn't apply at test volume.
const getDatabaseUrl = (): string =>
  resolveDatabaseUrl({ prod: 'DATABASE_URL_PROD_DIRECT', dev: 'DATABASE_URL_DEV_DIRECT' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: getDatabaseUrl(),
  },
});