import { HttpError } from '../../shared/errors/http-error.js';
import {
  fetchProjectIssues,
  readSentryApiConfig,
  SentryApiError,
  type SentryApiIssue,
  type SentryIssueStatus,
  type SentryProjectKey,
} from '../../shared/monitoring/sentry-api.client.js';
import { deployedCommit, errorMonitoringEnvironment } from '../../shared/monitoring/sentry.config.js';
import { systemHealthRepository } from './system-health.repository.js';
import type {
  SystemErrorFilters,
  SystemErrorIssue,
  SystemErrorsOutcome,
  SystemHealth,
} from './system-health.types.js';

// ─────────────────────────────────────────
//  SYSTEM HEALTH — super admin only (system-health.router.ts)
//
//  The error list is Sentry's issues for both projects, merged, newest
//  activity first, unresolved by default. Each answer (a failure included)
//  is cached for 60 seconds per filter combination, so however often the
//  screen is opened or refreshed, Sentry sees at most one request per
//  project per filter per minute. Health (commit, environment, uptime,
//  database) is cheap and is never cached.
// ─────────────────────────────────────────

export const SYSTEM_ERRORS_CACHE_MS = 60_000;

const PROJECTS: SentryProjectKey[] = ['backend', 'frontend'];
const STATUSES: SentryIssueStatus[] = ['unresolved', 'resolved', 'ignored'];
// Goes into Sentry's search query, so nothing but a plain name.
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export const SENTRY_NOT_CONFIGURED_MESSAGE =
  "Error monitoring isn't connected on this server. Set SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECTS to see errors here.";
export const SENTRY_UNAVAILABLE_MESSAGE =
  "Sentry didn't answer, so the error list can't be shown right now. Try again in a minute.";

const cache = new Map<string, { expiresAt: number; outcome: SystemErrorsOutcome }>();

const queryValue = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Each filter can be given once, as text.');
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const parseSystemErrorFilters = (query: Record<string, unknown>): SystemErrorFilters => {
  const environment = queryValue(query['environment']);
  const project = queryValue(query['project']);
  const status = queryValue(query['status']) ?? 'unresolved';

  if (environment !== null && !ENVIRONMENT_PATTERN.test(environment)) {
    throw new HttpError(400, 'An environment is a name of letters, numbers, dots, dashes and underscores.');
  }
  if (project !== null && !PROJECTS.includes(project as SentryProjectKey)) {
    throw new HttpError(400, "Project must be 'backend' or 'frontend', or left out for both.");
  }
  if (!STATUSES.includes(status as SentryIssueStatus)) {
    throw new HttpError(400, "Status must be 'unresolved', 'resolved' or 'ignored'.");
  }
  return { environment, project: project as SentryProjectKey | null, status: status as SentryIssueStatus };
};

const toIssue = (issue: SentryApiIssue, project: SentryProjectKey, environment: string | null): SystemErrorIssue => ({
  id: issue.id,
  title: issue.title,
  project,
  environment,
  level: issue.level,
  count: Number(issue.count) || 0,
  usersAffected: Number(issue.userCount) || 0,
  firstSeen: issue.firstSeen,
  lastSeen: issue.lastSeen,
  status: issue.status,
  link: issue.permalink,
});

const loadErrors = async (filters: SystemErrorFilters): Promise<SystemErrorsOutcome> => {
  const config = readSentryApiConfig();
  if (!config) return { ok: false, code: 'SENTRY_NOT_CONFIGURED', message: SENTRY_NOT_CONFIGURED_MESSAGE };

  const projects = filters.project ? [filters.project] : PROJECTS;
  try {
    const perProject = await Promise.all(
      projects.map(async (project) =>
        (await fetchProjectIssues(config, project, filters)).map((issue) => toIssue(issue, project, filters.environment))
      )
    );
    const issues = perProject
      .flat()
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    return { ok: true, list: { issues, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    if (!(err instanceof SentryApiError)) throw err;
    // The client's message names the project and the status, never the token.
    console.error(`[system health] ${err.message}`);
    return { ok: false, code: 'SENTRY_UNAVAILABLE', message: SENTRY_UNAVAILABLE_MESSAGE };
  }
};

const startedAt = new Date(Date.now() - process.uptime() * 1000);

export const systemHealthService = {
  getHealth: async (): Promise<SystemHealth> => {
    const pingStart = Date.now();
    const databaseOk = await systemHealthRepository.pingDatabase();
    return {
      commit: deployedCommit(),
      environment: errorMonitoringEnvironment(),
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: startedAt.toISOString(),
      database: { ok: databaseOk, latencyMs: databaseOk ? Date.now() - pingStart : null },
    };
  },

  getErrors: async (filters: SystemErrorFilters): Promise<SystemErrorsOutcome> => {
    const key = `${filters.environment ?? ''}|${filters.project ?? ''}|${filters.status}`;
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.outcome;

    const outcome = await loadErrors(filters);
    // Not configured asked Sentry nothing, so there is nothing to protect.
    if (!outcome.ok && outcome.code === 'SENTRY_NOT_CONFIGURED') return outcome;
    for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
    cache.set(key, { expiresAt: now + SYSTEM_ERRORS_CACHE_MS, outcome });
    return outcome;
  },

  // Tests only: forget every cached answer.
  clearCache: (): void => {
    cache.clear();
  },
};
