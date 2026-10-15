import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as Sentry from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/node';
import app, { CORS_REFUSED_MESSAGE } from '../../src/app.js';
import { buildSentryOptions } from '../../src/shared/monitoring/sentry.config.js';
import { MALFORMED_JSON_CODE, MALFORMED_JSON_MESSAGE } from '../../src/shared/middleware/malformed-json.middleware.js';

// ─────────────────────────────────────────
//  REFUSALS BEFORE ANY ROUTE — malformed JSON and a CORS-refused origin
//
//  Both used to fall through to the global handler as plain errors: a 500
//  with the generic message, reported to Sentry as if the server had
//  failed. They are the client's problem: a coded 400 and a 403, neither
//  reported. A real Sentry client records what it would send (nothing
//  leaves the process), as in tests/monitoring/error-capture.test.ts.
// ─────────────────────────────────────────

const captured: ErrorEvent[] = [];

beforeAll(() => {
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
});

afterAll(async () => {
  await Sentry.close();
  Sentry.getCurrentScope().setClient(undefined);
});

beforeEach(() => {
  captured.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () => Sentry.flush(2000);

describe('malformed JSON', () => {
  it('is a 400 with a clear message and a code, not reported', async () => {
    const res = await request(app)
      .post('/api/rsvp/submit')
      .set('Content-Type', 'application/json')
      .send('{"token": "abc", "attending": tru');
    await settle();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'error', message: MALFORMED_JSON_MESSAGE, code: MALFORMED_JSON_CODE });
    expect(MALFORMED_JSON_CODE).toBe('MALFORMED_JSON');
    // The parser's own message quotes the body; none of it comes back.
    expect(JSON.stringify(res.body)).not.toContain('tru');
    expect(captured).toEqual([]);
  });
});

describe('CORS', () => {
  it('refuses an origin outside the allowlist with a 403, not reported', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://not-allowed.example');
    await settle();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: 'error', message: CORS_REFUSED_MESSAGE });
    expect(captured).toEqual([]);
  });

  it('control: no Origin header is still let through', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

});

describe('control', () => {
  it('Sentry is really live in this file (so "nothing captured" above means something)', async () => {
    expect(Sentry.isInitialized()).toBe(true);
    Sentry.captureException(new Error('control capture'));
    await settle();
    expect(captured).toHaveLength(1);
  });
});
