import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import app from '../../src/app.js';
import { frontendUrl, assertFrontendUrlConfigured } from '../../src/shared/utils/frontend-url.util.js';
import { headersFor, installFirebaseMock } from '../helpers/team.js';
import { createPublicEvent, cleanupPublicEventFixtures } from '../public-events/helpers.js';

// ─────────────────────────────────────────
//  FRONTEND_BASE_URL — every link this server hands out (emails, share
//  links, payment callbacks) is built by frontendUrl, the only reader of
//  the variable. Missing or not an absolute URL stops the app at load
//  rather than sending "undefined/register?…" links.
// ─────────────────────────────────────────

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupPublicEventFixtures();
});

describe('frontendUrl', () => {
  it('joins the base (trailing slashes dropped) and the path', () => {
    vi.stubEnv('FRONTEND_BASE_URL', 'https://frontend.example.test//');
    expect(frontendUrl('/register?token=abc')).toBe('https://frontend.example.test/register?token=abc');
    expect(frontendUrl('billing/callback')).toBe('https://frontend.example.test/billing/callback');
  });

  it('throws, naming the variable, when it is missing, blank or not an absolute http(s) URL', () => {
    for (const value of ['', '   ', 'dev.e-velope.co.za', 'undefined', 'ftp://frontend.example.test']) {
      vi.stubEnv('FRONTEND_BASE_URL', value);
      expect(() => frontendUrl('/x')).toThrow(/FRONTEND_BASE_URL must be set/);
      expect(() => assertFrontendUrlConfigured()).toThrow(/FRONTEND_BASE_URL must be set/);
    }
    vi.stubEnv('FRONTEND_BASE_URL', undefined);
    expect(() => assertFrontendUrlConfigured()).toThrow(/it is missing/);
  });
});

describe('startup', () => {
  // Blank rather than deleted: dotenv (loaded again when the app's modules
  // reload) never overwrites a variable that is already set, so a deleted
  // one would come back from .env.
  it('loading the app with it blank throws before it can serve anything', async () => {
    vi.stubEnv('FRONTEND_BASE_URL', '');
    vi.resetModules();
    await expect(import('../../src/app.js')).rejects.toThrow(/FRONTEND_BASE_URL must be set/);
  }, 30000);

  it('loading the app with a real URL succeeds', async () => {
    vi.stubEnv('FRONTEND_BASE_URL', 'https://frontend.example.test');
    vi.resetModules();
    const mod = await import('../../src/app.js');
    expect(mod.default).toBeTypeOf('function');
  }, 30000);
});

describe('the share link', () => {
  it('is built by frontendUrl, on read and on regenerate', async () => {
    installFirebaseMock();
    const ev = await createPublicEvent();
    // A trailing slash only frontendUrl strips: a direct read would give "//register".
    vi.stubEnv('FRONTEND_BASE_URL', 'https://frontend.example.test/');

    const read = await request(app).get(`/api/events/${ev.eventId}/share-link`).set(headersFor(ev.organiser));
    expect(read.status).toBe(200);
    expect(read.body.data.url).toBe(`https://frontend.example.test/register?token=${ev.shareToken}`);

    const regenerated = await request(app).post(`/api/events/${ev.eventId}/share-link/regenerate`).set(headersFor(ev.organiser));
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.data.url).toMatch(/^https:\/\/frontend\.example\.test\/register\?token=[^/]+$/);
    expect(regenerated.body.data.url).not.toContain(ev.shareToken);
  }, 60000);
});

describe('no other reader', () => {
  // The payment callbacks (subscription, Event Pass, SMS bundle, ticket
  // purchase) aren't driven end to end here; this keeps every one of them,
  // and anything added later, on the helper.
  it('process.env.FRONTEND_BASE_URL is read only in frontend-url.util.ts', () => {
    const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(srcDir);
    const readers = files
      .filter((f) => /process\.env(\.FRONTEND_BASE_URL|\[\s*['"`]FRONTEND_BASE_URL)/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(srcDir, f))
      .filter((f) => f !== join('shared', 'utils', 'frontend-url.util.ts'));
    expect(readers).toEqual([]);
  });
});
