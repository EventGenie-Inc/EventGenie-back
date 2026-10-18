import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { PlatformRole } from '@prisma/client';
import app from '../../src/app.js';
import { ROUTE_NOT_FOUND_BODY } from '../../src/shared/middleware/feature.middleware.js';
import { systemHealthService } from '../../src/modules/system-health/system-health.service.js';
import {
  createActor,
  createTenant,
  deleteTenantsDeep,
  headersFor,
  installFirebaseMock,
  prisma,
  type Actor,
} from '../helpers/team.js';

// ─────────────────────────────────────────
//  GET /api/admin/system/errors — super admin only
//
//  Sentry's API is replaced with a stubbed fetch: no test reaches the real
//  Sentry. The auth token must never appear in a response.
// ─────────────────────────────────────────

const TOKEN = 'sntrys_test_token_never_leaves_the_server_0123456789';
const ENDPOINT = '/api/admin/system/errors';

let tenantId: string;
let superAdmin: Actor;
let tenantAdmin: Actor;
let eventAdmin: Actor;
const fetchMock = vi.fn();

const configureSentry = () => {
  vi.stubEnv('SENTRY_AUTH_TOKEN', TOKEN);
  vi.stubEnv('SENTRY_ORG', 'test-org');
  vi.stubEnv('SENTRY_PROJECTS', 'test-backend,test-frontend');
  vi.stubEnv('SENTRY_API_URL', 'https://sentry.test');
};

const issue = (id: string, title: string, lastSeen: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  level: 'error',
  status: 'unresolved',
  count: '12',
  userCount: 3,
  firstSeen: '2026-10-01T08:00:00Z',
  lastSeen,
  permalink: `https://test-org.sentry.io/issues/${id}/`,
  culprit: 'should not be passed on',
  metadata: { value: 'should not be passed on' },
  ...extra,
});

const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

const sentryAnswers = () => {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/test-backend/')) {
      return answer([issue('1', 'Backend older', '2026-10-12T10:00:00Z'), issue('2', 'Backend newest', '2026-10-13T09:00:00Z')]);
    }
    return answer([issue('3', 'Frontend middle', '2026-10-12T20:00:00Z')]);
  });
};

beforeAll(async () => {
  const tenant = await createTenant();
  tenantId = tenant.id;
  superAdmin = await createActor(PlatformRole.SUPER_ADMIN, null);
  tenantAdmin = await createActor(PlatformRole.TENANT_ADMIN, tenantId);
  eventAdmin = await createActor(PlatformRole.EVENT_ADMIN, tenantId);
}, 30000);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: superAdmin.id } });
  await deleteTenantsDeep([tenantId]);
});

beforeEach(() => {
  installFirebaseMock();
  systemHealthService.clearCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('who can see it', () => {
  it.each([
    ['TENANT_ADMIN', () => tenantAdmin],
    ['EVENT_ADMIN', () => eventAdmin],
  ])('a %s gets the global 404, and Sentry is never asked', async (_role, actor) => {
    configureSentry();
    sentryAnswers();
    const res = await request(app).get(ENDPOINT).set(headersFor(actor()));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(ROUTE_NOT_FOUND_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30000);

  it('signed out is a 401', async () => {
    const res = await request(app).get(ENDPOINT);
    expect(res.status).toBe(401);
  });
});

describe('Sentry not configured or not answering', () => {
  it('answers 503 SENTRY_NOT_CONFIGURED, with the health summary, and never a 500', async () => {
    vi.stubEnv('SENTRY_AUTH_TOKEN', '');
    vi.stubEnv('SENTRY_ORG', '');
    vi.stubEnv('SENTRY_PROJECTS', '');
    vi.stubEnv('RENDER_GIT_COMMIT', 'abc123def');

    const res = await request(app).get(ENDPOINT).set(headersFor(superAdmin));

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.code).toBe('SENTRY_NOT_CONFIGURED');
    expect(typeof res.body.message).toBe('string');
    expect(res.body.data.health).toMatchObject({ commit: 'abc123def', database: { ok: true } });
    expect(typeof res.body.data.health.uptimeSeconds).toBe('number');
    expect(typeof res.body.data.health.environment).toBe('string');
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30000);

  it.each([
    ['a network failure', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ['a 401 from Sentry', () => fetchMock.mockImplementation(() => answer({ detail: 'Invalid token' }, 401))],
    ['a 429 from Sentry', () => fetchMock.mockImplementation(() => answer({ detail: 'slow down' }, 429))],
    ['an unexpected body', () => fetchMock.mockImplementation(() => answer({ not: 'a list' }))],
  ])('answers 503 SENTRY_UNAVAILABLE on %s', async (_case, arrange) => {
    configureSentry();
    arrange();

    const res = await request(app).get(ENDPOINT).set(headersFor(superAdmin));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SENTRY_UNAVAILABLE');
    expect(res.body.data.health.database.ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  }, 30000);
});

describe('the error list', () => {
  it('merges both projects, newest activity first, unresolved by default, in the documented shape', async () => {
    configureSentry();
    sentryAnswers();

    const res = await request(app).get(ENDPOINT).set(headersFor(superAdmin));

    expect(res.status).toBe(200);
    expect(res.body.data.filters).toEqual({ environment: null, project: null, status: 'unresolved' });
    expect(res.body.data.issues.map((i: { title: string }) => i.title)).toEqual([
      'Backend newest',
      'Frontend middle',
      'Backend older',
    ]);
    expect(res.body.data.issues[0]).toEqual({
      id: '2',
      title: 'Backend newest',
      project: 'backend',
      environment: null,
      level: 'error',
      count: 12,
      usersAffected: 3,
      firstSeen: '2026-10-01T08:00:00Z',
      lastSeen: '2026-10-13T09:00:00Z',
      status: 'unresolved',
      link: 'https://test-org.sentry.io/issues/2/',
    });
    expect(res.body.data.issues[1].project).toBe('frontend');
    expect(Object.keys(res.body.data.health).sort()).toEqual(['commit', 'database', 'environment', 'startedAt', 'uptimeSeconds']);

    // Asked Sentry once per project, with the token, for unresolved issues.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url.startsWith('https://sentry.test/api/0/projects/test-org/')).toBe(true);
      expect(new URL(url).searchParams.get('query')).toBe('is:unresolved');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    }
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  }, 30000);

  it('passes the filters on: one project, an environment, a status', async () => {
    configureSentry();
    sentryAnswers();

    const res = await request(app)
      .get(`${ENDPOINT}?project=frontend&environment=production&status=resolved`)
      .set(headersFor(superAdmin));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/test-frontend/');
    expect(new URL(url).searchParams.get('query')).toBe('is:resolved environment:production');
    expect(res.body.data.issues).toHaveLength(1);
    expect(res.body.data.issues[0].environment).toBe('production');
  }, 30000);

  it('caches each answer for 60 seconds, so Sentry is asked once', async () => {
    configureSentry();
    sentryAnswers();

    const first = await request(app).get(ENDPOINT).set(headersFor(superAdmin));
    const second = await request(app).get(ENDPOINT).set(headersFor(superAdmin));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.issues).toEqual(first.body.data.issues);
    expect(fetchMock).toHaveBeenCalledTimes(2); // both projects, once

    // A minute later it asks again.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    await request(app).get(ENDPOINT).set(headersFor(superAdmin));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 30000);

  it.each([
    ['project=everything'],
    ['status=open'],
    ['environment=prod%20is:resolved'],
  ])('refuses a bad filter (%s) with a 400, asking Sentry nothing', async (query) => {
    configureSentry();
    sentryAnswers();
    const res = await request(app).get(`${ENDPOINT}?${query}`).set(headersFor(superAdmin));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30000);
});
