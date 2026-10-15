// ─────────────────────────────────────────
//  SENTRY API CLIENT — reads issues for the system health screen
//
//  Server-side only. SENTRY_AUTH_TOKEN is sent to Sentry in the
//  Authorization header and nowhere else: it is never logged, never put in
//  an error message, never returned to a client.
//
//  Config:
//  - SENTRY_AUTH_TOKEN  a token with read access to the projects' issues
//  - SENTRY_ORG         the organisation slug
//  - SENTRY_PROJECTS    "<backend slug>,<frontend slug>", in that order
//  - SENTRY_API_URL     optional. Defaults to the region in SENTRY_DSN's
//                       host (o….ingest.de.sentry.io → https://de.sentry.io),
//                       else https://sentry.io.
// ─────────────────────────────────────────

export type SentryProjectKey = 'backend' | 'frontend';
export type SentryIssueStatus = 'unresolved' | 'resolved' | 'ignored';

export interface SentryApiConfig {
  token: string;
  org: string;
  projects: Record<SentryProjectKey, string>;
  baseUrl: string;
}

// The fields this client reads from Sentry's issue list.
export interface SentryApiIssue {
  id: string;
  title: string;
  level: string;
  status: string;
  count: string | number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
}

export class SentryApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SentryApiError';
  }
}

const REQUEST_TIMEOUT_MS = 8000;
// One page per project. The screen lists what's newest; past this many
// open issues per project, the newest are what matter.
const ISSUES_PER_PROJECT = 100;

const defaultBaseUrl = (): string => {
  const dsn = process.env.SENTRY_DSN?.trim() ?? '';
  const region = /@[^/]*\.ingest\.([a-z]{2})\.sentry\.io/i.exec(dsn)?.[1];
  return region ? `https://${region.toLowerCase()}.sentry.io` : 'https://sentry.io';
};

// null when any part is missing: the endpoint answers 503 SENTRY_NOT_CONFIGURED.
export const readSentryApiConfig = (): SentryApiConfig | null => {
  const token = process.env.SENTRY_AUTH_TOKEN?.trim();
  const org = process.env.SENTRY_ORG?.trim();
  const [backend, frontend] = (process.env.SENTRY_PROJECTS ?? '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
  if (!token || !org || !backend || !frontend) return null;
  const baseUrl = (process.env.SENTRY_API_URL?.trim() || defaultBaseUrl()).replace(/\/+$/, '');
  return { token, org, projects: { backend, frontend }, baseUrl };
};

export const fetchProjectIssues = async (
  config: SentryApiConfig,
  project: SentryProjectKey,
  filters: { status: SentryIssueStatus; environment: string | null }
): Promise<SentryApiIssue[]> => {
  const slug = config.projects[project];
  const query = [`is:${filters.status}`, ...(filters.environment ? [`environment:${filters.environment}`] : [])].join(' ');
  const params = new URLSearchParams({ query, statsPeriod: '', limit: String(ISSUES_PER_PROJECT) });
  const url = `${config.baseUrl}/api/0/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(slug)}/issues/?${params}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout. The error's own text is not passed on.
    throw new SentryApiError(`Sentry did not answer for ${project} (${(err as Error).name})`);
  }
  if (!response.ok) {
    throw new SentryApiError(`Sentry answered ${response.status} for ${project}`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new SentryApiError(`Sentry sent an unexpected response for ${project}`);
  }
  return body as SentryApiIssue[];
};
