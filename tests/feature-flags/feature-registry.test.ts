import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { FEATURE_NAMES, parseDisabledFeatures } from '../../src/shared/features/feature-flags.js';

// ─────────────────────────────────────────
//  LAUNCH MODE — the feature registry itself
//
//  FEATURES_DISABLED is the only input. An unknown name must stop the app
//  from loading (not be ignored), and GET /api/config/features must report
//  exactly what the env says, to anyone, with no authentication.
// ─────────────────────────────────────────

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('feature registry — FEATURES_DISABLED parsing', () => {
  it('unset or blank means every feature is on', () => {
    expect(parseDisabledFeatures(undefined).size).toBe(0);
    expect(parseDisabledFeatures('').size).toBe(0);
    expect(parseDisabledFeatures(' , ').size).toBe(0);
  });

  it('reads known names, trimming whitespace', () => {
    expect([...parseDisabledFeatures(' vendors, ticketing ,sms')].sort()).toEqual(['sms', 'ticketing', 'vendors']);
  });

  it('an unknown name throws, naming it', () => {
    expect(() => parseDisabledFeatures('vendors,ticket')).toThrow(/unknown feature\(s\): ticket\b/);
    // Names are case-sensitive: a near miss is a typo, not a match.
    expect(() => parseDisabledFeatures('Vendors')).toThrow(/Vendors/);
  });
});

describe('feature registry — an unknown flag name fails startup', () => {
  it('loading the app with an unknown name throws before it can serve anything', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'vendors,notAFeature');
    vi.resetModules();
    await expect(import('../../src/app.js')).rejects.toThrow(/notAFeature/);
  }, 30000);

  it('loading the app with only known names succeeds', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'vendors,ticketing,sms,wallet,settingsPage,invitationDesigns');
    vi.resetModules();
    const mod = await import('../../src/app.js');
    expect(mod.default).toBeTypeOf('function');
  }, 30000);
});

describe('GET /api/config/features', () => {
  it('reports every feature on when nothing is disabled, with no auth', async () => {
    vi.stubEnv('FEATURES_DISABLED', '');
    const res = await request(app).get('/api/config/features');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(Object.fromEntries(FEATURE_NAMES.map((n) => [n, true])));
  });

  it('reflects the env: exactly the disabled names are false', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'vendors,ticketing,sms,wallet,settingsPage,invitationDesigns');
    const res = await request(app).get('/api/config/features');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      vendors: false,
      ticketing: false,
      sms: false,
      wallet: false,
      settingsPage: false,
      invitationDesigns: false,
      teamMembers: true,
      publicEvents: true,
      announcements: true,
    });
  });

  it('carries nothing but one boolean per registered feature', async () => {
    vi.stubEnv('FEATURES_DISABLED', 'publicEvents');
    const res = await request(app).get('/api/config/features');
    expect(Object.keys(res.body).sort()).toEqual(['data', 'status']);
    expect(Object.keys(res.body.data).sort()).toEqual([...FEATURE_NAMES].sort());
    for (const v of Object.values(res.body.data)) expect(typeof v).toBe('boolean');
  });
});
