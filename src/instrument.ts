import 'dotenv/config';
import { initErrorMonitoring } from './shared/monitoring/sentry.config.js';

// ─────────────────────────────────────────
//  ERROR MONITORING — started before anything else
//
//  server.ts imports this file FIRST, so Sentry is initialised before the
//  app module (and every router, Prisma, Firebase) loads, and its
//  uncaught-exception and unhandled-rejection handlers are in place
//  before any code that could throw. Without SENTRY_DSN it does nothing.
//  See shared/monitoring/sentry.config.ts.
// ─────────────────────────────────────────
if (initErrorMonitoring()) {
  console.log('✔  Error monitoring on (Sentry)');
}
