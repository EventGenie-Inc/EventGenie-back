// Must stay the first import: error monitoring starts before the app loads.
import './instrument.js';
import 'dotenv/config';
import app from './app.js';
import prisma from './shared/prisma/prisma.client.js';
import { flushErrorMonitoring } from './shared/monitoring/sentry.config.js';
import { reportError } from './shared/monitoring/error-reporting.js';
import { startFeedbackRequestSweeps } from './modules/feedback/feedback-request.service.js';

// ─────────────────────────────────────────
//  PORT
// ─────────────────────────────────────────
const PORT = process.env.PORT ?? 5000;

// ─────────────────────────────────────────
//  STARTUP
//  1. Verify database connection
//  2. Start Express server
//  3. Start the feedback-request sweep (feedback-request.service.ts) —
//     here, not in app.ts, so nothing that imports the app (the tests)
//     starts a timer
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

    startFeedbackRequestSweeps();
  } catch (error) {
    console.error('✘  Failed to start server:', error);
    reportError(error);
    await flushErrorMonitoring();
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
//  Sentry's own handlers (registered first, by instrument.ts) have
//  already captured the error; flush gives it a moment to be sent before
//  the process exits.
// ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('✘  Unhandled rejection:', reason);
  void flushErrorMonitoring().finally(() => process.exit(1));
});

process.on('uncaughtException', (error) => {
  console.error('✘  Uncaught exception:', error);
  void flushErrorMonitoring().finally(() => process.exit(1));
});

void start();