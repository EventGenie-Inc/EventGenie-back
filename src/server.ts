import 'dotenv/config';
import app from './app.js';
import prisma from './shared/prisma/prisma.client.js';

// ─────────────────────────────────────────
//  PORT
// ─────────────────────────────────────────
const PORT = process.env.PORT ?? 5000;

// ─────────────────────────────────────────
//  STARTUP
//  1. Verify database connection
//  2. Start Express server
// ─────────────────────────────────────────
const start = async (): Promise<void> => {
  try {
    // Verify Prisma can reach the database
    // before accepting any traffic.
    await prisma.$connect();
    console.log('✔  Database connected');

    app.listen(PORT, () => {
      console.log(`✔  Server running on port ${PORT}`);
      console.log(`✔  Environment: ${process.env.NODE_ENV ?? 'development'}`);
      console.log(`✔  Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('✘  Failed to start server:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
};

// ─────────────────────────────────────────
//  GRACEFUL SHUTDOWN
//  Ensures Prisma disconnects cleanly when
//  the process is stopped (Ctrl+C or deploy).
// ─────────────────────────────────────────
const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  await prisma.$disconnect();
  console.log('✔  Database disconnected');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─────────────────────────────────────────
//  UNHANDLED ERRORS
//  Catches anything that slips through.
// ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('✘  Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('✘  Uncaught exception:', error);
  process.exit(1);
});

void start();