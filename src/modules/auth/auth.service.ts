import jwt from 'jsonwebtoken';
import { getAuth } from 'firebase-admin/auth';
import { firebaseAdmin } from '../../shared/firebase/firebase.admin.js';
import { authRepository, OTP_TTL_MINUTES } from './auth.repository.js';
import { subscriptionTierConfigRepository } from '../subscription-tier-config/subscription-tier-config.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  issueDeviceToken,
  assertDeviceTokenUsable,
  revokeDeviceTokenByValue,
  REVOKE_REASON,
} from './device-token.util.js';
import {
  type RegisterDto,
  type VerifyOtpDto,
  type ExchangeSessionDto,
  type LogoutDto,
  type SessionTokenPayload,
} from './auth.types.js';
import { sendEmail } from '../../shared/messaging/email.engine.js';
import { normalizeEmail } from '../../shared/utils/email.util.js';
import { verifyOr401 } from '../../shared/firebase/firebase-token-error.util.js';
import { isUniqueViolationOn } from '../../shared/utils/prisma-error.util.js';
import { buildOtpEmail, buildPasswordResetEmail } from './auth-email.util.js';
import {
  buildPasswordResetLink,
  extractOobCode,
  passwordResetActionCodeSettings,
} from './password-reset-link.util.js';

// Never reveal whether an email exists in the system — every branch
// of forgotPassword() (unknown email, suspended account, send failure)
// returns this exact same shape.
const FORGOT_PASSWORD_GENERIC_RESPONSE = {
  message: 'If an account exists for this email, a password reset link has been sent.',
};

export const OTP_SEND_FAILED_MESSAGE = "We couldn't send your code. Try again in a moment.";

// ─────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────

const generateOtp = (): string =>
  Math.floor(100000 + Math.random() * 900000).toString();

const SESSION_TOKEN_TTL = '15m';

const REGISTER_EMAIL_TAKEN_MESSAGE = 'An account with this email already exists. Please log in.';
const REGISTER_SLUG_TAKEN_MESSAGE = 'This tenant slug is already taken. Please choose another.';
// request-otp and verify-otp: the Firebase sign-in behind the code step is
// no longer valid (it expired while the person read their email, or was
// revoked). Uncoded, like register's: the frontend's interceptor leaves an
// uncoded 401 on these two alone (there is no session yet for hardLogout to
// end), so the code form shows this message as it is.
export const OTP_TOKEN_INVALID_MESSAGE = 'Your sign-in has expired. Please sign in again to get a new code.';
export const REGISTER_TOKEN_INVALID_MESSAGE = "Your sign-in has expired or isn't valid. Please sign in again, then finish creating your account.";

const generateSessionToken = (payload: SessionTokenPayload): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not defined in .env');

  return jwt.sign(payload, secret, { expiresIn: SESSION_TOKEN_TTL });
};

const verifyFirebaseToken = async (token: string) =>
  getAuth(firebaseAdmin).verifyIdToken(token);

// Stricter variant — also checks Firebase's revocation list (checkRevoked),
// not just the token's own signature and expiry. Used by exchangeSession
// (a Firebase ID token ALONE, no OTP that request, is enough to mint a
// session there) and, since the Trusted Devices Hardening batch's Part 5,
// by refreshSession too — an already-open session must stop refreshing
// the moment a password reset revokes the underlying Firebase refresh
// token, or removing forgotPassword's own device-token revocation would
// leave a real gap. register and request/verify-otp remain on the
// lenient verifyFirebaseToken — evaluated for the same upgrade and left
// alone; see the batch report for the per-endpoint reasoning.
const verifyFirebaseTokenStrict = async (token: string) =>
  getAuth(firebaseAdmin).verifyIdToken(token, true);

// ─────────────────────────────────────────
//  Auth Service
// ─────────────────────────────────────────

export const authService = {

  register: async (firebaseToken: string, data: RegisterDto) => {
    // A bad or expired token is a 401 the person can act on, not a 500: the
    // usual case is a sign-up form left open long enough for the token to
    // expire.
    const decoded = await verifyOr401(() => verifyFirebaseToken(firebaseToken), REGISTER_TOKEN_INVALID_MESSAGE);

    const existingUser = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (existingUser) {
      throw new HttpError(409, 'An account already exists for this user. Please log in.');
    }

    const existingTenant = await authRepository.findTenantBySlug(data.tenantSlug);
    if (existingTenant) {
      throw new HttpError(409, REGISTER_SLUG_TAKEN_MESSAGE);
    }

    // Stored and compared lowercase and trimmed (shared/utils/email.util.ts).
    // Firebase already lowercases the address in its tokens; this makes it
    // a rule here rather than an assumption about Firebase.
    const email = normalizeEmail(decoded.email ?? '');

    const existingEmail = await authRepository.findUserByEmail(email);
    if (existingEmail) {
      throw new HttpError(409, REGISTER_EMAIL_TAKEN_MESSAGE);
    }

    // Registration always creates tenants on SPARK — Celebrate/Elevate
    // are upgrades made later, not chosen at signup. A missing config
    // row is a defensive no-op, not a lockout: don't let it accidentally
    // block all new signups.
    const sparkConfig = await subscriptionTierConfigRepository.findByTier('SPARK');
    if (sparkConfig && !sparkConfig.isAvailable) {
      throw new HttpError(503, 'New registrations are temporarily unavailable. Please try again later.');
    }

    let registered;
    try {
      registered = await authRepository.registerTenantAndAdmin(decoded.uid, email, data);
    } catch (err) {
      // Two registrations racing past the checks above: the unique index
      // stops the second, and it gets the same 409 the check would have
      // given, never a 500. (Tenant.email is the same address.)
      if (isUniqueViolationOn(err, 'User', 'email') || isUniqueViolationOn(err, 'Tenant', 'email')) {
        throw new HttpError(409, REGISTER_EMAIL_TAKEN_MESSAGE);
      }
      if (isUniqueViolationOn(err, 'Tenant', 'slug')) {
        throw new HttpError(409, REGISTER_SLUG_TAKEN_MESSAGE);
      }
      throw err;
    }
    const { user, tenant } = registered;

    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        subscriptionTier: tenant.subscriptionTier,
      },
    };
  },

  requestOtp: async (firebaseToken: string) => {
    // A rejected token is a 401 asking them to sign in again (never a 500);
    // a Firebase outage stays a 500. See OTP_TOKEN_INVALID_MESSAGE.
    const decoded = await verifyOr401(() => verifyFirebaseToken(firebaseToken), OTP_TOKEN_INVALID_MESSAGE);

    const user = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (!user) throw new HttpError(404, 'User not found. Please register first.');

    if (!user.isActive || user.isArchived) {
      throw new HttpError(403, 'Account is inactive or archived.');
    }

    await authRepository.invalidatePreviousOtps(user.id);

    const otp = generateOtp();
    const otpRecord = await authRepository.createOtp(user.id, otp);

    // A failed send is an error the user sees, not a silent "code sent":
    // otherwise they wait for an email that never comes. Saying so leaks
    // nothing — this caller has already proved the password (a verified
    // Firebase token for an existing, active user). The provider's reason
    // stays in the server log only.
    const sent = await sendEmail(
      buildOtpEmail({ to: user.email, username: user.username, code: otp, validMinutes: OTP_TTL_MINUTES })
    );
    if (!sent.ok) {
      console.error('Failed to send sign-in code email:', sent.reason);
      throw new HttpError(503, OTP_SEND_FAILED_MESSAGE, 'OTP_SEND_FAILED');
    }

    return {
      message: 'Verification code sent to your email.',
      otpExpiresAt: otpRecord.expiresAt.toISOString(),
    };
  },

  verifyOtp: async (firebaseToken: string, data: VerifyOtpDto, userAgent: string | null = null) => {
    const decoded = await verifyOr401(() => verifyFirebaseToken(firebaseToken), OTP_TOKEN_INVALID_MESSAGE);

    const user = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (!user) throw new HttpError(404, 'User not found.');

    if (!user.isActive || user.isArchived) {
      throw new HttpError(403, 'Account is inactive or archived.');
    }

    const otpRecord = await authRepository.findValidOtp(user.id, data.otp);
    if (!otpRecord) {
      throw new HttpError(400, 'Invalid or expired verification code.');
    }

    await authRepository.markOtpAsUsed(otpRecord.id);

    const payload: SessionTokenPayload = {
      userId: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    const sessionToken = generateSessionToken(payload);

    // Trusted Devices — this OTP verification is the one moment "this
    // device passed the second factor" becomes a fact worth remembering.
    // Every subsequent page load on THIS device can mint a session
    // through exchangeSession below without another OTP, until this
    // token is revoked or expires (30 days, extended by each use up to 90
    // days from issue) — see device-token.util.ts.
    const deviceToken = await issueDeviceToken(user.id, userAgent);

    return {
      sessionToken,
      expiresIn: SESSION_TOKEN_TTL,
      deviceToken: deviceToken.token,
      deviceTokenExpiresAt: deviceToken.expiresAt.toISOString(),
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
      },
    };
  },

  // The no-OTP path. Firebase ID token (Authorization header) proves who
  // they are; deviceToken proves THIS device already passed an OTP.
  // Neither is sufficient alone — see this module's device-token.util.ts
  // import comment and the batch report's "Firebase token alone" test.
  exchangeSession: async (firebaseToken: string, data: ExchangeSessionDto) => {
    // checkRevoked — see verifyFirebaseTokenStrict's own comment. This is
    // the one call site in this file that uses it, and the only one
    // where Firebase itself (not just this file's own catches elsewhere)
    // can surface 'auth/user-disabled': checkRevoked is what makes
    // verifyIdToken also look at the account's disabled flag, which
    // suspendFirebaseAccount sets. Caught explicitly here — proven by
    // testing to matter: without this, a suspended user's exchange
    // attempt threw an uncaught Firebase error past this function,
    // landing on the global handler's masked 500 instead of the same
    // clean 403 every other suspended-account check in this file uses.
    let decoded;
    try {
      decoded = await verifyFirebaseTokenStrict(firebaseToken);
    } catch (error) {
      const err = error as { code?: string; message: string };
      if (
        err.code === 'auth/id-token-expired' ||
        err.code === 'auth/argument-error' ||
        err.code === 'auth/id-token-revoked'
      ) {
        throw new HttpError(401, 'Firebase token is invalid or has expired', 'FIREBASE_TOKEN_INVALID');
      }
      if (err.code === 'auth/user-disabled') {
        throw new HttpError(403, 'Account is inactive or has been archived');
      }
      throw error;
    }

    const user = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (!user) throw new HttpError(404, 'User not found.');

    if (!user.isActive || user.isArchived) {
      throw new HttpError(403, 'Account is inactive or has been archived');
    }

    // Throws (generic 401, code DEVICE_NOT_RECOGNISED) if missing,
    // revoked, expired, or bound to a different user — see
    // assertDeviceTokenUsable's own comment on why those four cases
    // share one message AND one code. Distinguishing THIS from
    // FIREBASE_TOKEN_INVALID above is deliberately safe: whoever holds a
    // Firebase token can already check its own validity directly with
    // Firebase, so telling them "that part was fine" reveals nothing an
    // attacker couldn't already know. Distinguishing WITHIN the device
    // side (revoked vs. expired vs. wrong-user) would be the oracle —
    // assertDeviceTokenUsable never does that.
    await assertDeviceTokenUsable(data.deviceToken, user.id);

    const payload: SessionTokenPayload = {
      userId: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    const sessionToken = generateSessionToken(payload);

    return {
      sessionToken,
      expiresIn: SESSION_TOKEN_TTL,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
      },
    };
  },

  // Explicit, voluntary sign-out — "this device is no longer trusted"
  // (see the batch report's argued distinction from an idle timeout,
  // which must NOT reach this). Always succeeds: revoking a value that
  // is already gone, already revoked, or was never a real device token
  // has the identical end state as revoking a live one, and a logout
  // button that can show an error is worse than one that can't.
  logout: async (data: LogoutDto): Promise<{ message: string }> => {
    await revokeDeviceTokenByValue(data.deviceToken, REVOKE_REASON.LOGOUT);
    return { message: 'Signed out.' };
  },

  refreshSession: async (firebaseToken: string, currentSessionToken: string) => {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not defined in .env');

    let decoded;
    try {
      // Strict (checkRevoked) — Trusted Devices Hardening batch, Part 5.
      // Needed for forgotPassword's own revocation removal to actually
      // be true everywhere: an already-open session refreshing itself
      // must stop working once a password reset revokes the underlying
      // Firebase refresh token, or it could just keep refreshing every
      // 15 minutes past the reset until it idles out on its own,
      // regardless of the new password. See verifyFirebaseTokenStrict's
      // own comment — this is now its second call site.
      decoded = await verifyFirebaseTokenStrict(firebaseToken);
    } catch (error) {
      // Firebase Admin errors carry the reason in `.code` (e.g. 'auth/id-token-expired'),
      // not in `.message` — the human-readable message never contains these strings.
      const err = error as { code?: string; message: string };
      if (
        err.code === 'auth/id-token-expired' ||
        err.code === 'auth/argument-error' ||
        err.code === 'auth/id-token-revoked'
      ) {
        throw new HttpError(401, 'Firebase token is invalid or has expired');
      }
      // auth/user-disabled — same fix as exchangeSession (Part 4/the
      // identical auth.middleware.ts fix): checkRevoked can now surface
      // it here too, and it must map to the same clean 403 every other
      // suspended-account check in this file uses, not an uncaught throw.
      if (err.code === 'auth/user-disabled') {
        throw new HttpError(403, 'Account is inactive or has been archived');
      }
      throw error;
    }

    let payload: SessionTokenPayload;
    try {
      payload = jwt.verify(currentSessionToken, secret) as SessionTokenPayload;
    } catch (jwtError) {
      const err = jwtError as Error;
      if (err.name === 'TokenExpiredError') {
        throw new HttpError(401, 'Session has expired. Please refresh your session.', 'SESSION_EXPIRED');
      }
      throw new HttpError(401, 'Invalid session token. Please log in again.', 'SESSION_INVALID');
    }

    if (payload.firebaseUid !== decoded.uid) {
      throw new HttpError(401, 'Token mismatch. Please log in again.');
    }

    const user = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (!user) throw new HttpError(401, 'User not found in platform');
    if (!user.isActive || user.isArchived) {
      throw new HttpError(403, 'Account is inactive or has been archived');
    }

    const newPayload: SessionTokenPayload = {
      userId: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    const sessionToken = generateSessionToken(newPayload);

    return { sessionToken, expiresIn: SESSION_TOKEN_TTL };
  },

  forgotPassword: async (rawEmail: string) => {
    const email = normalizeEmail(typeof rawEmail === 'string' ? rawEmail : '');
    const firebaseUser = await getAuth(firebaseAdmin).getUserByEmail(email).catch(() => null);
    if (!firebaseUser) return FORGOT_PASSWORD_GENERIC_RESPONSE;

    // A suspended account (isArchived / !isActive) must not be able to
    // self-service a reset that lets it back in through a side door.
    // A Firebase user with no matching Postgres row is treated the
    // same way — either case returns the identical generic response.
    const user = await authRepository.findUserByFirebaseUid(firebaseUser.uid);
    if (!user || !user.isActive || user.isArchived) return FORGOT_PASSWORD_GENERIC_RESPONSE;

    try {
      // Firebase mints the code; the link we email is our own, on the
      // frontend's /auth/action page (password-reset-link.util.ts). If the
      // code can't be taken out of Firebase's link, NO email is sent —
      // never a broken link — and the error is logged without the code.
      // The response stays the generic one either way: an error only an
      // existing, active account could trigger would reveal that it exists.
      const firebaseLink = await getAuth(firebaseAdmin).generatePasswordResetLink(email, passwordResetActionCodeSettings());
      const resetLink = buildPasswordResetLink(extractOobCode(firebaseLink));

      // Trusted Devices Hardening batch, Part 5 — deliberately NOT
      // revoking device tokens here anymore. Requesting a reset link
      // needs nothing but a known email, so it was a free way for
      // anyone to force every one of a stranger's devices back to an
      // OTP (a real cost once SMS delivery is live) for essentially no
      // security gain: a COMPLETED reset already ends every existing
      // sign-in via Firebase's own token revocation on password change,
      // and exchangeSession's checkRevoked verification (see
      // verifyFirebaseTokenStrict) — now also refreshSession's, see that
      // function's own comment — means a device token paired with the
      // OLD password's Firebase session stops working the moment the
      // reset completes, with no action needed here. See STEERING.md's
      // revocation paragraph for the full argument.
      const sent = await sendEmail(buildPasswordResetEmail({ to: email, username: user.username, resetLink }));
      if (!sent.ok) console.error('Failed to send password reset email:', sent.reason);
    } catch (error) {
      // Never let a send failure leak account existence via a different
      // response shape — log server-side and fall through to the same
      // generic response as every other branch. Only the error's message
      // is logged: nothing raised above carries the reset code.
      console.error('Password reset email NOT sent:', error instanceof Error ? error.message : 'unknown error');
    }

    return FORGOT_PASSWORD_GENERIC_RESPONSE;
  },
};