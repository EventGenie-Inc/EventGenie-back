import { smsPortalProvider } from './smsportal.provider.js';

// ─────────────────────────────────────────
//  THE SMS PROVIDER — one interface, chosen by configuration
//
//  Knows text messages and nothing else: no guest, invite, event or tier.
//  Sends one SMS to one number and says what happened. The email-send
//  worker (which sends invitation and reminder texts too) is its only
//  caller; nothing else reaches a provider.
//
//  SMS_PROVIDER picks the implementation. Today: "smsportal" (SMSPortal,
//  smsportal.provider.ts). Unset or blank: no provider, so every text
//  fails with NOT_CONFIGURED_REASON and nothing is sent. Any other value
//  stops the app at load (assertSmsProviderConfigValid, app.ts), like an
//  unknown feature name. Twilio was the provider until 2026-11; it is gone.
//
//  Tests never reach a real provider: tests/setup.ts installs a fake with
//  setSmsProviderForTests before every test.
// ─────────────────────────────────────────

export interface OutgoingSms {
  // International form, +27…
  to: string;
  // GSM text, at most one part by the time it gets here.
  body: string;
  // Our own id for the message (the queue item's), given to the provider
  // so its delivery report can be matched to it.
  reference: string;
}

// What a single send call came to. The worker decides what follows:
//   ACCEPTED  the provider took it (in test mode: confirmed, not delivered).
//   REJECTED  refused for good: nothing was sent, and the same call would be
//             refused again (an invalid number, an opt-out, bad credentials).
//   RETRY     not taken, and certainly not sent (rate limited, the provider
//             unavailable, out of credits): safe to try again later.
//   UNKNOWN   no clear answer (a timeout, a server error mid-call): it may
//             have gone. Never sent again; its delivery report settles it.
export type SmsSendOutcome =
  | { status: 'ACCEPTED'; providerMessageId: string | null; parts: number; testMode: boolean }
  | { status: 'REJECTED'; reason: string; code?: string }
  | { status: 'RETRY'; reason: string }
  | { status: 'UNKNOWN'; reason: string };

export interface SmsProvider {
  readonly name: string;
  send(sms: OutgoingSms): Promise<SmsSendOutcome>;
}

export const SMS_PROVIDER_ENV = 'SMS_PROVIDER';
export const SMS_PROVIDER_NAMES = ['smsportal'] as const;

export const NOT_CONFIGURED_REASON = "Text messages aren't set up on this server, so nothing was sent.";

const notConfigured: SmsProvider = {
  name: 'none',
  send: async () => ({ status: 'REJECTED', reason: NOT_CONFIGURED_REASON }),
};

const configuredName = (): string => (process.env[SMS_PROVIDER_ENV] ?? '').trim().toLowerCase();

export const assertSmsProviderConfigValid = (): void => {
  const name = configuredName();
  if (name && !(SMS_PROVIDER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`${SMS_PROVIDER_ENV} is "${name}", which isn't a known SMS provider. Known: ${SMS_PROVIDER_NAMES.join(', ')}.`);
  }
};

let override: SmsProvider | null = null;

// Tests only (tests/setup.ts): every send goes to `provider` instead.
export const setSmsProviderForTests = (provider: SmsProvider | null): void => {
  override = provider;
};

// Read at call time, like the feature flags.
export const getSmsProvider = (): SmsProvider => {
  if (override) return override;
  return configuredName() === 'smsportal' ? smsPortalProvider : notConfigured;
};

// ─────────────────────────────────────────
//  PACING — one schedule shared by every text this process sends.
//  SMSPortal doesn't document a request rate limit; SMS_SENDS_PER_SECOND
//  (default 5) keeps a big send steady, and a 429 or 503 is retried anyway.
// ─────────────────────────────────────────

export const DEFAULT_SMS_SENDS_PER_SECOND = 5;

export const smsSendsPerSecond = (): number => {
  const configured = Number(process.env.SMS_SENDS_PER_SECOND);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SMS_SENDS_PER_SECOND;
};

let nextSlotAt = 0;

export const waitForSmsSlot = async (): Promise<void> => {
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + 1000 / smsSendsPerSecond();
  if (slot > now) await new Promise<void>((resolve) => setTimeout(resolve, slot - now));
};
