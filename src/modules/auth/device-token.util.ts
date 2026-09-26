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
const hashToken = (rawToken: string): string =>
  crypto.createHash('sha256').update(rawToken).digest('hex');

export const REVOKE_REASON = {
  LOGOUT: 'LOGOUT',
  PASSWORD_RESET: 'PASSWORD_RESET',
  USER_SUSPENDED: 'USER_SUSPENDED',
} as const;

// Called once per successful OTP verification (auth.service.ts's
// verifyOtp) — never on the exchange path, which only ever CONSUMES an
// existing device token, never mints one. Returns the raw value once;
// only its hash is ever persisted or seen again.
export const issueDeviceToken = async (userId: string): Promise<{ token: string; expiresAt: Date }> => {
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS);
  await deviceTokenRepository.create(userId, hashToken(token), expiresAt);
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
    throw new HttpError(401, 'This device is not recognised. Please sign in with your password and verify with a new code.');
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
