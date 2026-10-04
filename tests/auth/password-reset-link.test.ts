import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockGetUserByEmail, mockGeneratePasswordResetLink, mockResendSend } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';
import { buildPasswordResetLink, extractOobCode } from '../../src/modules/auth/password-reset-link.util.js';

// ─────────────────────────────────────────
//  THE RESET LINK WE EMAIL IS OUR OWN
//
//  Firebase mints the code (generatePasswordResetLink); only its oobCode is
//  kept, and the emailed link is <FRONTEND_BASE_URL>/auth/action — never
//  Firebase's hosted firebaseapp.com page, whose settings are locked. The
//  code is a live credential and must never reach a log line. If it can't
//  be extracted, no email is sent (never a broken link) and the response
//  is still the generic one.
// ─────────────────────────────────────────

const BASE = 'https://frontend.example.test';
// A code with characters that must be URL-encoded.
const CODE = 'Sx9_k-Q+/z=a&b';
const firebaseLink = (code: string | null = CODE) => {
  const u = new URL('https://e-velope-dev.firebaseapp.com/__/auth/action');
  u.searchParams.set('apiKey', 'AIzaFAKEKEY');
  u.searchParams.set('mode', 'resetPassword');
  if (code !== null) u.searchParams.set('oobCode', code);
  u.searchParams.set('continueUrl', `${BASE}/dashboard`);
  u.searchParams.set('lang', 'en');
  return u.toString();
};

let user: TestUser;
let savedBase: string | undefined;
const logSpies: MockInstance[] = [];

beforeAll(async () => {
  user = await createTestTenantAndUser();
  savedBase = process.env.FRONTEND_BASE_URL;
  process.env.FRONTEND_BASE_URL = BASE;
});

afterAll(async () => {
  if (savedBase === undefined) delete process.env.FRONTEND_BASE_URL;
  else process.env.FRONTEND_BASE_URL = savedBase;
  await deleteTestTenantAndUser(user);
  await prisma.$disconnect();
});

beforeEach(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    logSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
  }
});

afterEach(() => {
  while (logSpies.length) logSpies.pop()!.mockRestore();
});

// Everything written to the console during the test, as one string.
const logged = (): string =>
  logSpies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '))
    .join('\n');

const expectCodeNotLogged = () => {
  const text = logged();
  for (const form of [CODE, encodeURIComponent(CODE), new URLSearchParams({ c: CODE }).toString().slice(2)]) {
    expect(text).not.toContain(form);
  }
};

// forgot-password is rate limited per email (3) and per IP (5) in memory,
// so each request uses its own address and client IP (the app trusts one
// proxy hop). Firebase's lookup is mocked to the test user either way.
let requestNo = 0;
const requestReset = async (link: string) => {
  requestNo += 1;
  const email = `reset-${requestNo}-${user.email}`;
  mockGetUserByEmail.mockResolvedValueOnce({ uid: user.firebaseUid });
  mockGeneratePasswordResetLink.mockResolvedValueOnce(link);
  const res = await request(app)
    .post('/api/auth/forgot-password')
    .set('X-Forwarded-For', `203.0.113.${requestNo}`)
    .send({ email });
  return Object.assign(res, { email });
};

describe('POST /api/auth/forgot-password emails our own reset link', () => {
  it('the link is on the frontend origin, mode resetPassword, with the code, continueUrl and lang', async () => {
    const res = await requestReset(firebaseLink());
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/If an account exists/);

    expect(mockResendSend).toHaveBeenCalledTimes(1);
    const sent = mockResendSend.mock.calls[0]![0] as { html: string; text: string };
    const linkInText = sent.text.match(/Reset password:\n(\S+)/)![1]!;
    const url = new URL(linkInText);

    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe('/auth/action');
    expect([...url.searchParams.keys()]).toEqual(['mode', 'oobCode', 'continueUrl', 'lang']);
    expect(url.searchParams.get('mode')).toBe('resetPassword');
    expect(url.searchParams.get('oobCode')).toBe(CODE);
    expect(url.searchParams.get('continueUrl')).toBe(`${BASE}/dashboard`);
    expect(url.searchParams.get('lang')).toBe('en');
    // Every parameter URL-encoded: the raw code's & and = never appear.
    expect(linkInText).toContain(`oobCode=${encodeURIComponent(CODE).replace(/%20/g, '+')}`);
    expect(linkInText).toContain(`continueUrl=${encodeURIComponent(`${BASE}/dashboard`)}`);

    for (const part of [sent.html, sent.text]) {
      expect(part).not.toContain('firebaseapp.com');
      expect(part).not.toContain('AIzaFAKEKEY');
    }
    expectCodeNotLogged();
  });

  it('asks Firebase for a web link (handleCodeInApp false) with the frontend continue URL', async () => {
    const { email } = await requestReset(firebaseLink());
    expect(mockGeneratePasswordResetLink).toHaveBeenCalledWith(email, {
      url: `${BASE}/dashboard`,
      handleCodeInApp: false,
    });
  });

  it('a link with no code: no email sent, generic response, loud log without the link', async () => {
    const res = await requestReset(firebaseLink(null));
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/If an account exists/);
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(logged()).toMatch(/Password reset email NOT sent: .*no oobCode/);
    expect(logged()).not.toContain('AIzaFAKEKEY');
  });

  it('Resend failing never logs the code', async () => {
    mockResendSend.mockResolvedValueOnce({ data: null, error: { message: 'rate limited' } });
    const res = await requestReset(firebaseLink());
    expect(res.status).toBe(200);
    expect(logged()).toContain('rate limited');
    expectCodeNotLogged();
  });

  it('Resend throwing never logs the code', async () => {
    mockResendSend.mockRejectedValueOnce(new Error('socket hang up'));
    const res = await requestReset(firebaseLink());
    expect(res.status).toBe(200);
    expectCodeNotLogged();
  });
});

describe('extractOobCode / buildPasswordResetLink', () => {
  it('refuses a link without a code, or no URL at all, without echoing it', () => {
    for (const bad of [firebaseLink(null), 'not a url SECRET', firebaseLink('  ')]) {
      expect(() => extractOobCode(bad)).toThrow(/no oobCode/);
      try { extractOobCode(bad); } catch (e) { expect((e as Error).message).not.toContain('SECRET'); }
    }
  });

  it('round-trips a code through extraction and our link', () => {
    const ours = new URL(buildPasswordResetLink(extractOobCode(firebaseLink())));
    expect(ours.searchParams.get('oobCode')).toBe(CODE);
  });
});
