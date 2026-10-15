import { describe, it, expect } from 'vitest';
import type { Breadcrumb, ErrorEvent, EventHint } from '@sentry/node';
import { buildSentryOptions } from '../../src/shared/monitoring/sentry.config.js';

// ─────────────────────────────────────────
//  SENTRY PRIVACY SCRUBBER
//
//  One event carrying every kind of data that must never reach Sentry,
//  in every place it could sit (body, cookies, headers, URL path and
//  query, message, exception text, breadcrumbs, extra, tags, contexts,
//  user), fed through the production beforeSend and beforeBreadcrumb.
//  None of the secret values may survive anywhere in the output.
// ─────────────────────────────────────────

const options = buildSentryOptions('https://public@o0.ingest.sentry.io/0');
const beforeSend = options.beforeSend as (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
const beforeBreadcrumb = options.beforeBreadcrumb as (breadcrumb: Breadcrumb) => Breadcrumb | null;

const SECRETS = {
  bodyPassword: 'body-pass-Zx81',
  cookie: 'cookie-value-Qw77',
  firebaseIdToken: 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJhYmMifQ.firebaseSigPart',
  sessionToken: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxIn0.sessionSigPart',
  deviceToken: 'a'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab',
  inviteToken: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
  shareToken: 'c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8',
  teamInviteToken: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5',
  mistypedInviteToken: 'shortbroken-token',
  oobCode: 'AMzJoSl0uR3s3tC0d3Xy_9-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  otp: '482913',
  password: 'Sup3rS3cret!',
  email: 'thandi.mokoena@example.co.za',
  email2: 'GUEST.Two@Mail.Example.com',
  phoneIntl: '+27825551234',
  phoneLocal: '082 555 1234',
  bodyInJsonError: 'json-body-secret-77',
} as const;

const buildEvent = (): ErrorEvent => ({
  type: undefined,
  message: `Failed for ${SECRETS.email} (${SECRETS.phoneIntl}) with code ${SECRETS.otp}`,
  transaction: `GET /api/rsvp/validate/${SECRETS.inviteToken}`,
  request: {
    method: 'POST',
    url: `https://api.e-velope.co.za/api/public-events/${SECRETS.shareToken}/register?email=${encodeURIComponent(SECRETS.email)}&token=${SECRETS.inviteToken}`,
    query_string: `token=${SECRETS.inviteToken}&oobCode=${SECRETS.oobCode}`,
    data: { password: SECRETS.bodyPassword, deviceToken: SECRETS.deviceToken, email: SECRETS.email },
    cookies: { sid: SECRETS.cookie },
    headers: {
      authorization: `Bearer ${SECRETS.firebaseIdToken}`,
      'x-session-token': SECRETS.sessionToken,
      cookie: `sid=${SECRETS.cookie}`,
      'user-agent': 'Mozilla/5.0 test',
      referer: `https://e-velope.co.za/join?token=${SECRETS.teamInviteToken}`,
    },
    env: { REMOTE_ADDR: '10.0.0.1' },
  },
  user: {
    id: 'user-1',
    email: SECRETS.email,
    username: 'Thandi Mokoena',
    ip_address: '10.0.0.1',
    phone: SECRETS.phoneIntl,
    role: 'TENANT_ADMIN',
    tenantId: 'tenant-1',
  },
  exception: {
    values: [
      {
        type: 'Error',
        value:
          `Session ${SECRETS.sessionToken} for ${SECRETS.email2} rejected; device ${SECRETS.deviceToken}; ` +
          `reset link https://e-velope.co.za/auth/action?mode=resetPassword&oobCode=${SECRETS.oobCode} ` +
          `password=${SECRETS.password} phone ${SECRETS.phoneLocal} invite /api/rsvp/validate/${SECRETS.mistypedInviteToken}`,
        stacktrace: {
          frames: [{ filename: 'app.js', function: 'handler', vars: { password: SECRETS.password, otp: SECRETS.otp } }],
        },
      },
      {
        type: 'SyntaxError',
        value: `Unexpected token 'p', "{"note":"${SECRETS.bodyInJsonError}", p" is not valid JSON`,
      },
    ],
  },
  breadcrumbs: [
    { category: 'console', message: `Sent OTP ${SECRETS.otp} to ${SECRETS.email}` },
    {
      category: 'http',
      data: {
        url: `https://api.resend.com/emails?to=${encodeURIComponent(SECRETS.email)}`,
        method: 'POST',
        'http.query': `oobCode=${SECRETS.oobCode}`,
      },
    },
    { category: 'auth', message: `Device token ${SECRETS.deviceToken} used`, data: { deviceToken: SECRETS.deviceToken, sessionToken: SECRETS.sessionToken } },
  ],
  extra: {
    inviteToken: SECRETS.inviteToken,
    note: `Contact ${SECRETS.phoneLocal} or ${SECRETS.email2}`,
    nested: { deeper: { otpCode: SECRETS.otp, link: `/join?token=${SECRETS.teamInviteToken}` } },
  },
  tags: { guestEmail: SECRETS.email, route: 'POST /api/public-events/:shareToken/register' },
  sdkProcessingMetadata: {
    normalizedRequest: {
      url: `https://api.e-velope.co.za/api/rsvp/validate/${SECRETS.inviteToken}?email=${SECRETS.email}`,
      query_string: `email=${SECRETS.email}`,
      headers: { authorization: `Bearer ${SECRETS.firebaseIdToken}` },
    },
    ipAddress: '10.0.0.1',
  },
  contexts: {
    trace: { trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' },
    request_info: { referrer: `https://e-velope.co.za/rsvp/${SECRETS.inviteToken}?x=1` },
  },
});

describe('Sentry privacy scrubber', () => {
  it('lets none of the forbidden values through anywhere in an event', () => {
    const out = beforeSend(buildEvent(), {});
    expect(out).not.toBeNull();
    const serialised = JSON.stringify(out);

    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialised, `${name} survived the scrubber`).not.toContain(secret);
    }
    // Case-insensitive for the addresses, and no address of any shape.
    expect(serialised.toLowerCase()).not.toContain(SECRETS.email2.toLowerCase());
    expect(serialised).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    // No query string on any URL.
    expect(out!.request!.url).not.toContain('?');
    expect(serialised).not.toMatch(/https?:\/\/[^"\s]*\?/);
    // Removed, not masked.
    expect(out!.request).not.toHaveProperty('data');
    expect(out!.request).not.toHaveProperty('cookies');
    expect(out!.request).not.toHaveProperty('query_string');
    expect(out!.request).not.toHaveProperty('env');
    expect(Object.keys(out!.request!.headers ?? {}).map((h) => h.toLowerCase())).toEqual(['user-agent']);
    expect(out!.exception!.values![0]!.stacktrace!.frames![0]).not.toHaveProperty('vars');
    expect(out!.sdkProcessingMetadata).not.toHaveProperty('normalizedRequest');
    expect(serialised).not.toContain('10.0.0.1');
  });

  it('keeps the user to id, role and tenantId', () => {
    const out = beforeSend(buildEvent(), {});
    expect(out!.user).toEqual({ id: 'user-1', role: 'TENANT_ADMIN', tenantId: 'tenant-1' });
  });

  it('keeps what is needed to fix the error', () => {
    const out = beforeSend(buildEvent(), {});
    expect(out!.request!.method).toBe('POST');
    expect(out!.request!.url).toBe('https://api.e-velope.co.za/api/public-events/[Filtered]/register');
    expect(out!.transaction).toBe('GET /api/rsvp/validate/[Filtered]');
    expect(out!.exception!.values![0]!.type).toBe('Error');
    expect(out!.exception!.values![0]!.stacktrace!.frames![0]!.function).toBe('handler');
    expect(out!.tags!['route']).toBe('POST /api/public-events/:shareToken/register');
    // The SDK's own trace ids are left intact.
    expect(out!.contexts!['trace']).toEqual({ trace_id: '0123456789abcdef0123456789abcdef', span_id: '0123456789abcdef' });
  });

  it('scrubs breadcrumbs as they are recorded, too', () => {
    const crumbs = buildEvent().breadcrumbs!.map((b) => beforeBreadcrumb(b));
    const serialised = JSON.stringify(crumbs);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialised, `${name} survived beforeBreadcrumb`).not.toContain(secret);
    }
    expect(crumbs[1]!.data!['url']).toBe('https://api.resend.com/emails');
  });
});
