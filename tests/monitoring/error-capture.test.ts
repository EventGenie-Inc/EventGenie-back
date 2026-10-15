import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as Sentry from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/node';
import { PlatformRole } from '@prisma/client';
import app from '../../src/app.js';
import { HttpError } from '../../src/shared/errors/http-error.js';
import { inviteRepository } from '../../src/modules/invite/invite.repository.js';
import { systemHealthService } from '../../src/modules/system-health/system-health.service.js';
import { buildSentryOptions } from '../../src/shared/monitoring/sentry.config.js';
import { reportUnreportedServerErrors, skipServerErrorReport } from '../../src/shared/monitoring/error-reporting.js';
import { createActor, headersFor, installFirebaseMock, prisma, type Actor } from '../helpers/team.js';

// ─────────────────────────────────────────
//  WHAT REACHES SENTRY
//
//  A real Sentry client with the production options (scrubber included),
//  except that beforeSend records the scrubbed event and returns null, so
//  nothing leaves the process. Expected refusals (HttpError 4xx) are never
//  captured; unexpected errors and every 5xx are, with the user as id,
//  role and tenantId only.
// ─────────────────────────────────────────

const captured: ErrorEvent[] = [];
let superAdmin: Actor;

beforeAll(async () => {
  const options = buildSentryOptions('https://public@o0.ingest.sentry.io/0');
  const productionBeforeSend = options.beforeSend as (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
  Sentry.init({
    ...options,
    beforeSend: (event, hint) => {
      const out = productionBeforeSend(event, hint);
      if (out) captured.push(out);
      return null;
    },
  });
  superAdmin = await createActor(PlatformRole.SUPER_ADMIN, null);
}, 30000);

afterAll(async () => {
  await Sentry.close();
  Sentry.getCurrentScope().setClient(undefined);
  await prisma.user.deleteMany({ where: { id: superAdmin.id } });
});

beforeEach(() => {
  captured.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const settle = () => Sentry.flush(2000);

describe('error capture', () => {
  it('is really on in this file (so "nothing captured" below means something)', () => {
    expect(Sentry.isInitialized()).toBe(true);
  });

  it.each([400, 403, 404, 409, 410, 422, 429])('does not capture an HttpError %i (an expected refusal)', async (status) => {
    // A distinct message per status: Sentry's Dedupe drops an event identical
    // to the previous one, which would hide a wrongly captured 4xx.
    vi.spyOn(inviteRepository, 'findByToken').mockRejectedValueOnce(new HttpError(status, `Refused as designed (${status}).`, 'SOME_CODE'));

    const res = await request(app).get('/api/rsvp/validate/any-token');
    await settle();

    expect(res.status).toBe(status);
    expect(captured).toEqual([]);
  });

  it('captures an unexpected error (500), with the route and no token from the URL', async () => {
    const token = 'f'.repeat(64);
    vi.spyOn(inviteRepository, 'findByToken').mockRejectedValueOnce(new Error('database fell over'));

    const res = await request(app).get(`/api/rsvp/validate/${token}?email=someone@example.com`);
    await settle();

    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
    const event = captured[0]!;
    expect(event.exception?.values?.[0]?.value).toBe('database fell over');
    expect(event.tags?.['route']).toBe('GET /api/rsvp/validate/:token');
    expect(event.request?.url).not.toContain('?');
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain('someone@example.com');
  });

  it('captures an HttpError 503', async () => {
    vi.spyOn(inviteRepository, 'findByToken').mockRejectedValueOnce(new HttpError(503, 'Provider down.', 'OTP_SEND_FAILED'));

    const res = await request(app).get('/api/rsvp/validate/any-token');
    await settle();

    expect(res.status).toBe(503);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.exception?.values?.[0]?.value).toBe('Provider down.');
  });

  it("attaches the signed-in user as id, role and tenantId only", async () => {
    installFirebaseMock();
    vi.stubEnv('SENTRY_AUTH_TOKEN', ''); // never reach the real Sentry API from a test
    vi.spyOn(systemHealthService, 'getHealth').mockRejectedValueOnce(new Error('health blew up'));

    const res = await request(app).get('/api/admin/system/errors').set(headersFor(superAdmin));
    await settle();

    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.user).toEqual({ id: superAdmin.id, role: 'SUPER_ADMIN', tenantId: null });
    expect(JSON.stringify(captured[0])).not.toContain(superAdmin.email);
  }, 30000);
});

describe('5xx safety net (a handler that answers 5xx itself)', () => {
  const mini = express();
  mini.use(reportUnreportedServerErrors);
  mini.get('/direct-500', (_req, res) => {
    res.status(500).json({ status: 'error' });
  });
  mini.get('/explained-503', (_req, res) => {
    skipServerErrorReport(res);
    res.status(503).json({ status: 'error' });
  });
  mini.get('/fine', (_req, res) => {
    res.status(404).json({ status: 'error' });
  });

  it('reports a 5xx sent directly', async () => {
    await request(mini).get('/direct-500?token=abc');
    await settle();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.message).toBe('GET /direct-500 responded 500');
  });

  it('leaves an explained 503 and a 4xx alone', async () => {
    await request(mini).get('/explained-503');
    await request(mini).get('/fine');
    await settle();
    expect(captured).toEqual([]);
  });
});
