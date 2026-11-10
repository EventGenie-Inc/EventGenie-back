import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockResendSend } from '../setup.js';
import {
  sendEmail,
  sendEmailBatch,
  sendEmailAttempt,
  waitForSendSlot,
  DEFAULT_EMAIL_SENDS_PER_SECOND,
  emailSendsPerSecond,
  type InlineImage,
} from '../../src/shared/messaging/email.engine.js';

// ─────────────────────────────────────────
//  ONE EMAIL PER CALL, PACED (email.engine.ts)
//
//  Invitations and reminders carry an inline QR code, which Resend's batch
//  endpoint can't take, so the email-send worker sends them one call each:
//  every call first takes a slot of one schedule shared by the process
//  (waitForSendSlot), at most EMAIL_SENDS_PER_SECOND a second; each call
//  (sendEmailAttempt) carries an idempotency key and says whether a
//  failure is worth retrying. The inline image reaches the SDK as an
//  attachment with a content id and base64 content.
// ─────────────────────────────────────────

afterEach(() => {
  vi.unstubAllEnvs();
});

const email = (to: string) => ({ to, from: '"x" <x@test.invalid>', subject: 's', html: '<p>h</p>', text: 't' });

const image: InlineImage = { contentId: 'invite-qr', filename: 'e-velope-qr.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };

describe('the send pace', () => {
  it('defaults to 6 a second, overridable by EMAIL_SENDS_PER_SECOND', () => {
    vi.stubEnv('EMAIL_SENDS_PER_SECOND', '');
    expect(DEFAULT_EMAIL_SENDS_PER_SECOND).toBe(6);
    expect(emailSendsPerSecond()).toBe(6);
    vi.stubEnv('EMAIL_SENDS_PER_SECOND', 'nonsense');
    expect(emailSendsPerSecond()).toBe(6);
    vi.stubEnv('EMAIL_SENDS_PER_SECOND', '9');
    expect(emailSendsPerSecond()).toBe(9);
  });

  it('hands out no more slots than the configured number a second, however many ask at once', async () => {
    vi.stubEnv('EMAIL_SENDS_PER_SECOND', '20');
    const times: number[] = [];
    await Promise.all(Array.from({ length: 10 }, async () => {
      await waitForSendSlot();
      times.push(performance.now());
    }));
    const sorted = [...times].sort((x, y) => x - y);
    // 10 slots at 20 a second: slot i at least i × 50 ms after the first.
    // Slots are scheduled at absolute times, so this is the guarantee; two
    // neighbouring gaps can't each be checked, since one timer firing late
    // under load brings it closer to the next (the full suite saw 34 ms),
    // without letting more through in any second.
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[0]!).toBeGreaterThanOrEqual(i * 50 - 15);
  });
});

describe('sendEmailAttempt', () => {
  it('makes exactly one call, with the idempotency key', async () => {
    expect(await sendEmailAttempt(email('a@test.invalid'), 'email-send-item/abc')).toEqual({ ok: true, messageId: 'test' });
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    expect(mockResendSend.mock.calls[0]![1]).toEqual({ idempotencyKey: 'email-send-item/abc' });
  });

  it('a 429, a 5xx, a concurrent call with the key, or no answer is worth retrying; a refusal is not', async () => {
    const cases: [unknown, boolean][] = [
      [{ data: null, error: { message: 'Too many requests', name: 'rate_limit_exceeded', statusCode: 429 } }, true],
      [{ data: null, error: { message: 'Internal', name: 'internal_server_error', statusCode: 500 } }, true],
      [{ data: null, error: { message: 'Busy', name: 'concurrent_idempotent_requests', statusCode: 409 } }, true],
      [{ data: null, error: { message: 'Unable to fetch data', name: 'application_error', statusCode: null } }, true],
      [{ data: null, error: { message: 'Invalid `to` field', name: 'validation_error', statusCode: 422 } }, false],
    ];
    for (const [response, retryable] of cases) {
      mockResendSend.mockResolvedValueOnce(response);
      const result = await sendEmailAttempt(email('a@test.invalid'), 'k');
      expect(result).toMatchObject({ ok: false, retryable });
    }
    mockResendSend.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await sendEmailAttempt(email('a@test.invalid'), 'k')).toEqual({ ok: false, reason: 'socket hang up', retryable: true });
  });

  it('the key already used for this email means an earlier call was accepted: sent', async () => {
    mockResendSend.mockResolvedValueOnce({ data: null, error: { message: 'Same key, different body', name: 'invalid_idempotent_request', statusCode: 422 } });
    expect(await sendEmailAttempt(email('a@test.invalid'), 'k')).toEqual({ ok: true, alreadySent: true });
  });

  it('hands the SDK an inline image as an attachment with its content id, the content base64', async () => {
    await sendEmailAttempt({ ...email('a@test.invalid'), inlineImages: [image] }, 'k');
    await sendEmail({ ...email('b@test.invalid'), inlineImages: [image] });
    for (const call of mockResendSend.mock.calls) {
      expect(call[0].attachments).toEqual([{ content: 'iVBORw==', filename: 'e-velope-qr.png', contentType: 'image/png', contentId: 'invite-qr' }]);
    }
    // No images, no attachments key at all.
    mockResendSend.mockClear();
    await sendEmail(email('c@test.invalid'));
    expect(mockResendSend.mock.calls[0]![0]).not.toHaveProperty('attachments');
  });

  it('the batch endpoint cannot be handed an inline image (a compile error, checked by typecheck:tests)', async () => {
    // @ts-expect-error — sendEmailBatch takes OutgoingEmail, whose inlineImages is never.
    await sendEmailBatch([{ ...email('a@test.invalid'), inlineImages: [image] }]);
  });
});
