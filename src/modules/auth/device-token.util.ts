import crypto from 'crypto';
import { deviceTokenRepository } from './device-token.repository.js';
import { generateSecureToken } from '../../shared/utils/token.util.js';
import { HttpError } from '../../shared/errors/http-error.js';

// 30 days. Long enough that the feature actually solves the problem it
// exists for (a phone that opens the app every few days, not every few
// minutes, should never see an OTP prompt) while keeping the exposure
// window of a stolen device token — the scenario this whole design is a
// deliberate, knowing trade-off against (see auth.service.ts's own header
// comment) — bounded to something re-earned regularly rather than
// indefinite. Revisited the moment "sign out everywhere" ships and gives
// a user their own lever against a token that's overstayed its welcome.
export const DEVICE_TOKEN_TTL_DAYS = 30;

const DEVICE_TOKEN_TTL_MS = DEVICE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

// SHA-256 of the raw value — deterministic, so a lookup can still be an
// exact-match query, but the raw 256-bit token itself is never at rest in
// the database (see the model's own schema comment for why this is a
// different bar than the plaintext invite/share tokens elsewhere).
//
// Exported — rate-limit.middleware.ts's exchangeSessionDeviceLimiter
// keys its in-memory bucket by this same hash, never the raw token,
// for the identical reason: a raw credential must not sit anywhere in
// server memory as a literal object key for the length of a rate-limit
// window, any more than it sits in the database.
export const hashToken = (rawToken: string): string =>
  crypto.createHash('sha256').update(rawToken).digest('hex');

// PASSWORD_RESET was removed as a trigger here (Trusted Devices
// Hardening batch, Part 5 — see auth.service.ts's forgotPassword and
// STEERING.md's revocation paragraph for why); deliberately not kept as
// a dead reason value.
export const REVOKE_REASON = {
  LOGOUT: 'LOGOUT',
  USER_SUSPENDED: 'USER_SUSPENDED',
} as const;

// User-Agent strings are unbounded in principle (a handful of browsers
// pad theirs with extra tokens) — truncated defensively so one oddly
// long header can never become an oversized column value. 512 is
// generous against every real-world User-Agent this codebase has seen.
const USER_AGENT_MAX_LENGTH = 512;

// Called once per successful OTP verification (auth.service.ts's
// verifyOtp) — never on the exchange path, which only ever CONSUMES an
// existing device token, never mints one. Returns the raw value once;
// only its hash is ever persisted or seen again.
//
// userAgent is captured for a future device-management screen only —
// Trusted Devices Hardening batch, Part 6. Nothing reads it yet, and
// nothing in assertDeviceTokenUsable/exchangeSession depends on it in
// any way; a caller with no header (or a device token issued before
// this column existed) simply has null here.
export const issueDeviceToken = async (
  userId: string,
  userAgent: string | null = null
): Promise<{ token: string; expiresAt: Date }> => {
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS);
  const truncatedUserAgent = userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null;
  await deviceTokenRepository.create(userId, hashToken(token), expiresAt, truncatedUserAgent);
  return { token, expiresAt };
};

// The read/validate side — called by exchangeSession before it will mint
// a session with no OTP. Deliberately ONE generic failure for "doesn't
// exist" / "belongs to someone else" / "revoked" / "expired": a device
// token found to belong to a different user must fail exactly like one
// that doesn't exist at all, or the error itself becomes an oracle for
// "is this random value a live credential for account X." Touches
// lastUsedAt on success — not a rotation (see the module header comment
// on DeviceToken), just a "when was this last actually used" fact for a
// future device-management/audit view.
export const assertDeviceTokenUsable = async (rawToken: string, userId: string): Promise<void> => {
  const record = await deviceTokenRepository.findByHash(hashToken(rawToken));

  const usable =
    record !== null &&
    record.userId === userId &&
    record.revokedAt === null &&
    record.expiresAt.getTime() > Date.now();

  if (!usable) {
    // DEVICE_NOT_RECOGNISED — deliberately the SAME code for all four
    // underlying cases (missing/wrong-user/revoked/expired). Splitting it
    // further is exactly the oracle this function's own header comment
    // already refuses to create.
    throw new HttpError(
      401,
      'This device is not recognised. Please sign in with your password and verify with a new code.',
      'DEVICE_NOT_RECOGNISED'
    );
  }

  await deviceTokenRepository.touchLastUsed(record!.id);
};

// Revocation entry points. Each caller supplies its own reason (see
// REVOKE_REASON) so the audit trail says WHY, not just when.
export const revokeDeviceTokenByValue = async (rawToken: string, reason: string): Promise<void> => {
  const record = await deviceTokenRepository.findByHash(hashToken(rawToken));
  if (!record) return; // Already gone, or never existed — logout is idempotent either way.
  await deviceTokenRepository.revoke(record.id, reason);
};

export const revokeAllDeviceTokensForUser = async (userId: string, reason: string): Promise<void> => {
  await deviceTokenRepository.revokeAllForUser(userId, reason);
};
