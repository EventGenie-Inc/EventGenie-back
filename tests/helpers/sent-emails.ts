import { mockResendSend, mockResendBatchSend, acceptWholeBatch } from '../setup.js';

// ─────────────────────────────────────────
//  What the suite "sent" through Resend (mocked in tests/setup.ts), across
//  both endpoints: one email at a time (sign-in codes, registration, a
//  single resend) and batches (invitations, reminders, announcements, the
//  cancellation email; email.engine.ts's sendEmailBatch). A test asks who
//  was emailed, not which endpoint carried it.
// ─────────────────────────────────────────

export interface SentEmail {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

export const sentEmails = (): SentEmail[] => [
  ...mockResendSend.mock.calls.map((call) => call[0] as SentEmail),
  ...mockResendBatchSend.mock.calls.flatMap((call) => call[0] as SentEmail[]),
];

export const clearSentEmails = (): void => {
  mockResendSend.mockClear();
  mockResendBatchSend.mockClear();
};

// Resend refuses the emails to these addresses, on either endpoint (in a
// batch, the way permissive validation reports one email by its index);
// everything else is accepted.
export const failEmailsTo = (addresses: string[], message: string): void => {
  mockResendSend.mockImplementation(async (msg: { to: string }) =>
    addresses.includes(msg.to) ? { data: null, error: { message } } : { data: { id: 'ok' }, error: null }
  );
  mockResendBatchSend.mockImplementation(async (payload: { to: string }[]) => ({
    data: {
      data: payload.filter((m) => !addresses.includes(m.to)).map((_, i) => ({ id: `batch-${i}` })),
      errors: payload.flatMap((m, index) => (addresses.includes(m.to) ? [{ index, message }] : [])),
    },
    error: null,
  }));
};

// Back to the default: every email accepted.
export const acceptAllEmails = (): void => {
  mockResendSend.mockResolvedValue({ data: { id: 'ok' }, error: null });
  mockResendBatchSend.mockImplementation(acceptWholeBatch);
};
