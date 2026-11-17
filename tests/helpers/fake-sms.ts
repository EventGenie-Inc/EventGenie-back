import { type OutgoingSms, type SmsProvider, type SmsSendOutcome } from '../../src/shared/messaging/sms-provider.js';

// ─────────────────────────────────────────
//  THE FAKE SMS PROVIDER — installed for every test by tests/setup.ts, so
//  no test ever reaches SMSPortal or spends a credit. Records every text it
//  is asked to send; accepts each as one part by default. A test sets
//  `fakeSms.next(...)` to answer the next calls differently.
// ─────────────────────────────────────────

let sent: OutgoingSms[] = [];
let queuedAnswers: SmsSendOutcome[] = [];
let counter = 0;

export const fakeSms = {
  provider: {
    name: 'fake',
    send: async (sms: OutgoingSms): Promise<SmsSendOutcome> => {
      sent.push(sms);
      const answer = queuedAnswers.shift();
      if (answer) return answer;
      counter += 1;
      return { status: 'ACCEPTED', providerMessageId: `fake-${counter}`, parts: 1, testMode: true };
    },
  } satisfies SmsProvider,
  // Every text sent so far (this test).
  sent: (): OutgoingSms[] => [...sent],
  // Texts to one number.
  sentTo: (to: string): OutgoingSms[] => sent.filter((s) => s.to === to),
  // The answers the next calls get, in order; after them, ACCEPTED again.
  next: (...answers: SmsSendOutcome[]): void => {
    queuedAnswers.push(...answers);
  },
  reset: (): void => {
    sent = [];
    queuedAnswers = [];
  },
};
