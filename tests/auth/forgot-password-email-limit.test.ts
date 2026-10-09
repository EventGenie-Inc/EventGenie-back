import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import { forgotPasswordEmailKey } from '../../src/shared/middleware/rate-limit.middleware.js';

// ─────────────────────────────────────────
//  FORGOT PASSWORD — the per-email limiter (3 per 15 minutes). Keyed by the
//  hash of the normalised email; a request with no email falls back to its
//  IP (ipKeyGenerator), never to one bucket shared by every such request.
//  Its own file: the limiter's store lives for the test process.
// ─────────────────────────────────────────

describe('forgotPasswordEmailKey', () => {
  it('is the hash of the normalised email, never the address', () => {
    const key = forgotPasswordEmailKey({ email: '  Thandi@Example.TEST ' }, '1.2.3.4');
    expect(key).toMatch(/^forgot-email:[0-9a-f]{64}$/);
    expect(key).not.toMatch(/thandi|example/i);
    expect(forgotPasswordEmailKey({ email: 'thandi@example.test' }, '5.6.7.8')).toBe(key);
  });

  it('with no usable email, is keyed by the IP', () => {
    expect(forgotPasswordEmailKey({}, '1.2.3.4')).toBe(forgotPasswordEmailKey({ email: '  ' }, '1.2.3.4'));
    expect(forgotPasswordEmailKey({ email: 42 }, '1.2.3.4')).toBe(forgotPasswordEmailKey({}, '1.2.3.4'));
    expect(forgotPasswordEmailKey({}, '1.2.3.4')).not.toBe(forgotPasswordEmailKey({}, '9.9.9.9'));
  });
});

describe('requests with no email', () => {
  it('one IP using up its budget does not refuse another IP', async () => {
    const send = (ip: string) => request(app).post('/api/auth/forgot-password').set('X-Forwarded-For', ip).send({});

    for (let i = 1; i <= 3; i++) expect((await send('10.77.0.1')).status, `attempt ${i}`).toBe(400);
    const fourth = await send('10.77.0.1');
    expect(fourth.status).toBe(429);
    expect(fourth.body.message).toBe('Too many password reset requests. Please try again later.');

    // Before: every email-less request shared one 'unknown' bucket, so
    // this was refused too.
    expect((await send('10.77.0.2')).status).toBe(400);
  });
});
