import { describe, it, expect } from 'vitest';
import { parseSystemErrorFilters } from '../../src/modules/system-health/system-health.service.js';

// ─────────────────────────────────────────
//  The System health environment filter, without the database
//
//  The environment names both apps report: SENTRY_ENVIRONMENT on Render
//  (dev, staging, prod) and the frontend's environment files. Each is
//  passed on as given. The HTTP path is tests/system-health/system-errors.test.ts.
// ─────────────────────────────────────────

describe('parseSystemErrorFilters: environment', () => {
  it.each(['dev', 'staging', 'prod'])('accepts %s', (environment) => {
    expect(parseSystemErrorFilters({ environment })).toEqual({ environment, project: null, status: 'unresolved' });
  });

  it('control: still refuses anything but a plain name', () => {
    expect(() => parseSystemErrorFilters({ environment: 'staging is:resolved' })).toThrow(
      'An environment is a name of letters, numbers, dots, dashes and underscores.'
    );
  });
});
