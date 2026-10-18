import type { SentryIssueStatus, SentryProjectKey } from '../../shared/monitoring/sentry-api.client.js';

export interface SystemErrorFilters {
  environment: string | null;
  project: SentryProjectKey | null;
  status: SentryIssueStatus;
}

export interface SystemErrorIssue {
  id: string;
  title: string;
  project: SentryProjectKey;
  // The environment filter when one was given; null when the list spans
  // every environment (Sentry's issue list doesn't name one per issue).
  environment: string | null;
  level: string;
  count: number;
  usersAffected: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
  link: string;
}

export interface SystemHealth {
  commit: string | null;
  environment: string;
  uptimeSeconds: number;
  startedAt: string;
  database: { ok: boolean; latencyMs: number | null };
}

export interface SystemErrorsList {
  issues: SystemErrorIssue[];
  fetchedAt: string;
}

export type SystemErrorsFailureCode = 'SENTRY_NOT_CONFIGURED' | 'SENTRY_UNAVAILABLE';

export type SystemErrorsOutcome =
  | { ok: true; list: SystemErrorsList }
  | { ok: false; code: SystemErrorsFailureCode; message: string };
