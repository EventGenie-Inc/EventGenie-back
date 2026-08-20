import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import { getAuth } from 'firebase-admin/auth';
import { firebaseAdmin } from '../../shared/firebase/firebase.admin.js';
import { authRepository } from './auth.repository.js';
import { subscriptionTierConfigRepository } from '../subscription-tier-config/subscription-tier-config.repository.js';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  type RegisterDto,
  type VerifyOtpDto,
  type SessionTokenPayload,
} from './auth.types.js';

// Never reveal whether an email exists in the system — every branch
// of forgotPassword() (unknown email, suspended account, send failure)
// returns this exact same shape.
const FORGOT_PASSWORD_GENERIC_RESPONSE = {
  message: 'If an account exists for this email, a password reset link has been sent.',
};

const resend = new Resend(process.env.RESEND_API_KEY);

// ─────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────

const generateOtp = (): string =>
  Math.floor(100000 + Math.random() * 900000).toString();

const SESSION_TOKEN_TTL = '15m';

const generateSessionToken = (payload: SessionTokenPayload): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not defined in .env');

  return jwt.sign(payload, secret, { expiresIn: SESSION_TOKEN_TTL });
};

const verifyFirebaseToken = async (token: string) =>
  getAuth(firebaseAdmin).verifyIdToken(token);

// ─────────────────────────────────────────
//  Auth Service
// ─────────────────────────────────────────

export const authService = {

  register: async (firebaseToken: string, data: RegisterDto) => {
    const decoded = await verifyFirebaseToken(firebaseToken);

    const existingUser = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (existingUser) {
      throw new HttpError(409, 'An account already exists for this user. Please log in.');
    }

    const existingTenant = await authRepository.findTenantBySlug(data.tenantSlug);
    if (existingTenant) {
      throw new HttpError(409, 'This tenant slug is already taken. Please choose another.');
    }

    const existingEmail = await authRepository.findUserByEmail(decoded.email ?? '');
    if (existingEmail) {
      throw new HttpError(409, 'An account with this email already exists. Please log in.');
    }

    // Registration always creates tenants on SPARK — Celebrate/Elevate
    // are upgrades made later, not chosen at signup. A missing config
    // row is a defensive no-op, not a lockout: don't let it accidentally
    // block all new signups.
    const sparkConfig = await subscriptionTierConfigRepository.findByTier('SPARK');
    if (sparkConfig && !sparkConfig.isAvailable) {
      throw new HttpError(503, 'New registrations are temporarily unavailable. Please try again later.');
    }

    const { user, tenant } = await authRepository.registerTenantAndAdmin(
      decoded.uid,
      decoded.email ?? '',
      data
    );

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
    const decoded = await verifyFirebaseToken(firebaseToken);

    const user = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (!user) throw new HttpError(404, 'User not found. Please register first.');

    if (!user.isActive || user.isArchived) {
      throw new HttpError(403, 'Account is inactive or archived.');
    }

    await authRepository.invalidatePreviousOtps(user.id);

    const otp = generateOtp();
    const otpRecord = await authRepository.createOtp(user.id, otp);

    const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';

    await resend.emails.send({
      from: fromEmail,
      to: user.email,
      subject: 'Your EventGenie verification code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1A1A2E;">EventGenie Verification</h2>
          <p>Hello ${user.username},</p>
          <p>Your verification code is:</p>
          <div style="
            font-size: 36px;
            font-weight: bold;
            letter-spacing: 8px;
            color: #C6A43A;
            padding: 24px;
            background: #F7F5F0;
            border-radius: 8px;
            text-align: center;
            margin: 24px 0;
          ">
            ${otp}
          </div>
          <p style="color: #6B6B80; font-size: 14px;">
            This code expires in <strong>10 minutes</strong>.<br/>
            If you did not request this, please ignore this email.
          </p>
        </div>
      `,
    });

    return {
      message: 'Verification code sent to your email.',
      otpExpiresAt: otpRecord.expiresAt.toISOString(),
    };
  },

  verifyOtp: async (firebaseToken: string, data: VerifyOtpDto) => {
    const decoded = await verifyFirebaseToken(firebaseToken);

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

  refreshSession: async (firebaseToken: string, currentSessionToken: string) => {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not defined in .env');

    let decoded;
    try {
      decoded = await verifyFirebaseToken(firebaseToken);
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

  forgotPassword: async (email: string) => {
    const firebaseUser = await getAuth(firebaseAdmin).getUserByEmail(email).catch(() => null);
    if (!firebaseUser) return FORGOT_PASSWORD_GENERIC_RESPONSE;

    // A suspended account (isArchived / !isActive) must not be able to
    // self-service a reset that lets it back in through a side door.
    // A Firebase user with no matching Postgres row is treated the
    // same way — either case returns the identical generic response.
    const user = await authRepository.findUserByFirebaseUid(firebaseUser.uid);
    if (!user || !user.isActive || user.isArchived) return FORGOT_PASSWORD_GENERIC_RESPONSE;

    try {
      const actionCodeSettings = {
        url: `${process.env.FRONTEND_BASE_URL}/reset-password`,
        handleCodeInApp: true,
      };

      const resetLink = await getAuth(firebaseAdmin).generatePasswordResetLink(email, actionCodeSettings);

      const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';

      await resend.emails.send({
        from: fromEmail,
        to: email,
        subject: 'Reset your EventGenie password',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="color: #1A1A2E;">Reset your EventGenie password</h2>
            <p>Hello ${user.username},</p>
            <p>We received a request to reset your password. Click the button below to choose a new one:</p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${resetLink}" style="
                display: inline-block;
                padding: 14px 32px;
                background: #C6A43A;
                color: #1A1A2E;
                font-weight: bold;
                text-decoration: none;
                border-radius: 8px;
              ">
                Reset Password
              </a>
            </div>
            <p style="color: #6B6B80; font-size: 14px;">
              This link will expire shortly.<br/>
              If you did not request this, please ignore this email — your password will remain unchanged.
            </p>
          </div>
        `,
      });
    } catch (error) {
      // Never let a send failure leak account existence via a different
      // response shape — log server-side and fall through to the same
      // generic response as every other branch.
      console.error('Failed to send password reset email:', error);
    }

    return FORGOT_PASSWORD_GENERIC_RESPONSE;
  },
};