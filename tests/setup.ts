import { vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────
//  NODE_ENV=test — set here, not just in the npm script, so it is true
//  the instant this file (a setupFile, guaranteed to run before the test
//  file's own imports) executes. src/shared/prisma/prisma.client.ts and
//  prisma.config.ts both key off this to route to DATABASE_URL_TEST —
//  see prisma.client.ts's own comment on why that separation is
//  load-bearing (dev and prod share one Neon endpoint today).
//
//  PRISMA_TEST_ADAPTER=pg — the ONLY place this repo ever sets it.
//  prisma.client.ts checks for exactly this value (alongside
//  NODE_ENV === 'test') to route to a plain TCP connection
//  (@prisma/adapter-pg) instead of Neon's WebSocket driver for the
//  reasons explained there — a WebSocket that this environment
//  occasionally drops mid-query, and a suspend-after-idle Free-tier
//  Neon branch. Nothing else in this repo — not .env, not
//  prisma.config.ts, not package.json's scripts — ever sets this
//  variable, which is what makes `npm run dev`/`npm start`/production
//  provably unable to reach the pg branch: the flag they'd need is
//  simply never defined in their process.
// ─────────────────────────────────────────
process.env.NODE_ENV = 'test';
process.env.PRISMA_TEST_ADAPTER = 'pg';

// ─────────────────────────────────────────
//  FEATURE FLAGS — every feature ON, whatever .env says.
//
//  .env's FEATURES_DISABLED is the developer's own launch-mode setup
//  (e.g. ticketing and sms off), and a test must not pass or fail by it.
//  Set here, before any test file's imports, so dotenv (which never
//  overwrites a variable that already exists, an empty one included)
//  leaves it alone. A test that needs a flag off sets it itself with
//  vi.stubEnv('FEATURES_DISABLED', …); vi.unstubAllEnvs() comes back here.
// ─────────────────────────────────────────
process.env.FEATURES_DISABLED = '';

// ─────────────────────────────────────────
//  FIREBASE ADMIN — stubbed at ONE boundary: verifyIdToken.
//
//  Every real call site (auth.service.ts's verifyFirebaseToken and
//  verifyFirebaseTokenStrict, auth.middleware.ts's inline call) goes
//  through `getAuth(firebaseAdmin).verifyIdToken(...)`, imported from
//  'firebase-admin/auth'. Mocking that one module here — not each call
//  site individually, and not by refactoring production code to accept
//  an injected verifier — means the suite exercises the REAL
//  auth.service.ts/auth.middleware.ts source, unmodified, with only the
//  actual network call to Google intercepted.
//
//  mockVerifyIdToken is a single shared vi.fn() — individual tests
//  import it and configure per-call behaviour with
//  mockResolvedValueOnce/mockRejectedValueOnce. Reset before every test
//  so one test's configuration can never leak into the next.
//
//  firebase-admin/app (src/shared/firebase/firebase.admin.ts) is NOT
//  mocked — it only constructs a local SDK app object from .env
//  credentials already present for dev, no network call at import time,
//  so it is harmless to let it run for real.
// ─────────────────────────────────────────
export const mockVerifyIdToken = vi.fn();

// Added for Part 5 (Trusted Devices Hardening batch): testing
// forgotPassword requires these two, since it also calls
// getAuth(firebaseAdmin) — same mocked module, same "one boundary."
// Part 1/2/3/4's tests never touch these; they stay undefined-safe
// (mockReset(), not a fixed default) so nothing accidentally depends on
// a default success.
export const mockGetUserByEmail = vi.fn();
export const mockGeneratePasswordResetLink = vi.fn();

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
    getUserByEmail: mockGetUserByEmail,
    generatePasswordResetLink: mockGeneratePasswordResetLink,
  }),
}));

// forgotPassword also sends a real email via Resend regardless of outcome
// (errors there are swallowed — see auth.service.ts). Stubbed for the
// same reason as Firebase: no real third-party network call from this
// suite. Defaults to a successful send so tests that don't care about
// email delivery specifically don't need to configure it themselves.
export const mockResendSend = vi.fn();

// Resend's batch endpoint (email.engine.ts's sendEmailBatch): guest emails
// to more than one recipient go out up to 100 per call. Defaults to every
// email in the batch accepted, in permissive mode (errors: [] means none
// refused). Tests read what was sent through tests/helpers/sent-emails.ts,
// which covers both endpoints.
export const mockResendBatchSend = vi.fn();
export const acceptWholeBatch = async (payload: unknown[]) => ({
  data: { data: payload.map((_, i) => ({ id: `batch-${i}` })), errors: [] },
  error: null,
});

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockResendSend };
    batch = { send: mockResendBatchSend };
  },
}));

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockGetUserByEmail.mockReset();
  mockGeneratePasswordResetLink.mockReset();
  mockResendSend.mockReset();
  mockResendSend.mockResolvedValue({ data: { id: 'test' }, error: null });
  mockResendBatchSend.mockReset();
  mockResendBatchSend.mockImplementation(acceptWholeBatch);
});
