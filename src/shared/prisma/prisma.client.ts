import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import dotenv from 'dotenv';

dotenv.config();

// ─────────────────────────────────────────
//  Resolve the correct database URL
//  based on the current NODE_ENV.
// ─────────────────────────────────────────

const getDatabaseUrl = (): string => {
  const env = process.env.NODE_ENV ?? 'development';

  if (env === 'production') {
    const url = process.env.DATABASE_URL_PROD;
    if (!url) throw new Error('DATABASE_URL_PROD is not defined in .env');
    return url;
  }

  const url = process.env.DATABASE_URL_DEV;
  if (!url) throw new Error('DATABASE_URL_DEV is not defined in .env');
  return url;
};

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