import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { mockVerifyIdToken, mockGetUserByEmail, mockGeneratePasswordResetLink, mockResendSend } from '../setup.js';
import { createTestTenantAndUser, deleteTestTenantAndUser, prisma, type TestUser } from '../helpers/db.js';

// ─────────────────────────────────────────
//  SECURITY SWEEP BEFORE G3 — FOLLOW-UP 3
//
//  auth.service.ts's OTP and password-reset email builders interpolate
//  user.username unescaped — same vulnerability class as Fix 3
//  (buildInviteEmailHtml), flagged as out of scope there ("Anything in
//  auth") and fixed here on explicit request. A hostile username must
//  render escaped in both emails, sent under e-velope's own address.
// ─────────────────────────────────────────

const HOSTILE_USERNAME = `<script>alert(1)</script> "&'`;
const ESCAPED_USERNAME = '&lt;script&gt;alert(1)&lt;/script&gt; &quot;&amp;&#39;';

let user: TestUser;
const FIREBASE_TOKEN = 'follow-up3-firebase-token';

beforeAll(async () => {
  user = await createTestTenantAndUser();
  await prisma.user.update({ where: { id: user.id }, data: { username: HOSTILE_USERNAME } });
});

beforeEach(() => {
  mockVerifyIdToken.mockImplementation(async (token: string) => {
    if (token === FIREBASE_TOKEN) return { uid: user.firebaseUid };
    const err = new Error('Decoding Firebase ID token failed') as Error & { code: string };
    err.code = 'auth/argument-error';
    throw err;
  });
});

afterAll(async () => {
  await deleteTestTenantAndUser(user);
  await prisma.$disconnect();
});

describe('auth emails — username is escaped', () => {
  it('POST /api/auth/request-otp escapes the username in the verification email', async () => {
    const res = await request(app)
      .post('/api/auth/request-otp')
      .set('Authorization', `Bearer ${FIREBASE_TOKEN}`)
      .send();
    expect(res.status).toBe(200);

    expect(mockResendSend).toHaveBeenCalled();
    const html = mockResendSend.mock.calls[mockResendSend.mock.calls.length - 1][0].html as string;
    expect(html).not.toContain(HOSTILE_USERNAME);
    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_USERNAME);
  });

  it('POST /api/auth/forgot-password escapes the username in the reset email', async () => {
    mockGetUserByEmail.mockResolvedValueOnce({ uid: user.firebaseUid });
    mockGeneratePasswordResetLink.mockResolvedValueOnce('https://example.test/reset?oobCode=fake');

    const res = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(200);

    expect(mockResendSend).toHaveBeenCalled();
    const html = mockResendSend.mock.calls[mockResendSend.mock.calls.length - 1][0].html as string;
    expect(html).not.toContain(HOSTILE_USERNAME);
    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED_USERNAME);
  });
});

// Both auth emails go out through the shared layout (email-layout.ts) on
// the real request path, with a plain-text part and the "e-velope" sender.
describe('auth emails — shared layout, plain-text part, sender', () => {
  const lastSend = () =>
    mockResendSend.mock.calls[mockResendSend.mock.calls.length - 1][0] as {
      from: string; subject: string; html: string; text: string;
    };

  it('the sign-in code email', async () => {
    const res = await request(app).post('/api/auth/request-otp').set('Authorization', `Bearer ${FIREBASE_TOKEN}`).send();
    expect(res.status).toBe(200);
    const sent = lastSend();
    expect(sent.subject).toBe('Your e-velope sign-in code');
    expect(sent.from).toMatch(/^"e-velope" <.+>$/);
    expect(sent.html).toContain('data-eg-email-layout="1"');
    expect(sent.text).toMatch(/\n\d{6}\n/);
    expect(sent.text).toContain("It's valid for 10 minutes.");
  });

  it('the password reset email', async () => {
    mockGetUserByEmail.mockResolvedValueOnce({ uid: user.firebaseUid });
    mockGeneratePasswordResetLink.mockResolvedValueOnce('https://example.test/reset?oobCode=fake');
    const res = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(200);
    const sent = lastSend();
    expect(sent.subject).toBe('Reset your e-velope password');
    expect(sent.from).toMatch(/^"e-velope" <.+>$/);
    expect(sent.html).toContain('data-eg-email-layout="1"');
    // Our own link on the frontend, carrying Firebase's code — never Firebase's link.
    const link = new URL(sent.text.match(/Reset password:\n(\S+)/)![1]!);
    expect(link.pathname).toBe('/auth/action');
    expect(link.searchParams.get('mode')).toBe('resetPassword');
    expect(link.searchParams.get('oobCode')).toBe('fake');
    expect(sent.text).not.toContain('example.test/reset');
  });
});
