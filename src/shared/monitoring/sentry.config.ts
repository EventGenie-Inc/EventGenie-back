import * as Sentry from '@sentry/node';
import { scrubBreadcrumb, scrubEvent } from './sentry-scrub.js';

// ─────────────────────────────────────────
//  ERROR MONITORING (Sentry) — configuration
//
//  Permanent infrastructure, not a feature: no flag. On when SENTRY_DSN is
//  set, and nothing at all happens without it (no client, no network).
//  Initialised by src/instrument.ts, the first import of server.ts, so it
//  is in place before the app module loads.
//
//  - environment: SENTRY_ENVIRONMENT (falls back to NODE_ENV).
//  - release: the deployed commit, RENDER_GIT_COMMIT (Render sets it).
//  - Tracing is OFF (no tracesSampleRate). Errors are what we need from
//    Sentry; Render's own metrics already show latency. A span carries the
//    URL and database statement text of every sampled request, a second
//    privacy surface this scrubber would have to cover, and it spends the
//    plan's quota. Revisit with a very low rate (0.01) only for a specific
//    performance question.
//  - dataCollection collects nothing personal (no request bodies, cookies,
//    query strings, user info or local variables), and every event and
//    breadcrumb also goes through sentry-scrub.ts on its way out.
// ─────────────────────────────────────────

export const errorMonitoringEnvironment = (): string =>
  process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim() || 'development';

// The commit Render deployed, or null outside Render.
export const deployedCommit = (): string | null => process.env.RENDER_GIT_COMMIT?.trim() || null;

export const buildSentryOptions = (dsn: string): Sentry.NodeOptions => {
  const release = deployedCommit();
  return {
    dsn,
    environment: errorMonitoringEnvironment(),
    ...(release !== null && { release }),
    // v11 replaced sendDefaultPii with dataCollection, whose defaults
    // collect EVERYTHING (cookies, headers, bodies, query params, user
    // info, local variables). Each category is switched off here, so it is
    // never collected; the scrubber is the second line, not the only one.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent', 'content-type', 'content-length', 'accept', 'host'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    includeLocalVariables: false,
    integrations: (defaults) => [
      // The request body is never read into an event in the first place.
      ...defaults.filter((integration) => integration.name !== 'Http'),
      Sentry.httpIntegration({ maxRequestBodySize: 'none' }),
    ],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  };
};

// Called once, by src/instrument.ts. Returns whether monitoring is on.
export const initErrorMonitoring = (): boolean => {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  Sentry.init(buildSentryOptions(dsn));
  return true;
};

// Before the process exits on a fatal error, give queued events a moment to leave.
export const flushErrorMonitoring = async (timeoutMs = 2000): Promise<void> => {
  if (!Sentry.isInitialized()) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
};
