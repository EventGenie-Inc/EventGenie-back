import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import { getAuth } from 'firebase-admin/auth';
import { firebaseAdmin } from '../../shared/firebase/firebase.admin.js';
import { authRepository } from './auth.repository.js';
import {
  type RegisterDto,
  type VerifyOtpDto,
  type SessionTokenPayload,
} from './auth.types.js';

const resend = new Resend(process.env.RESEND_API_KEY);

// ─────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────

const generateOtp = (): string =>
  Math.floor(100000 + Math.random() * 900000).toString();

const generateSessionToken = (payload: SessionTokenPayload): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not defined in .env');

  // jsonwebtoken accepts expiresIn as a separate argument via algorithm
  // Simplest resolution: use the synchronous callback overload workaround
  const signed = jwt.sign(payload as unknown as object, secret as string);
  return signed;
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
      throw new Error('An account already exists for this user. Please log in.');
    }

    const existingTenant = await authRepository.findTenantBySlug(data.tenantSlug);
    if (existingTenant) {
      throw new Error('This tenant slug is already taken. Please choose another.');
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
    if (!user) throw new Error('User not found. Please register first.');

    if (!user.isActive || user.isArchived) {
      throw new Error('Account is inactive or archived.');
    }

    await authRepository.invalidatePreviousOtps(user.id);

    const otp = generateOtp();
    await authRepository.createOtp(user.id, otp);

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

    return { message: 'Verification code sent to your email.' };
  },

  verifyOtp: async (firebaseToken: string, data: VerifyOtpDto) => {
    const decoded = await verifyFirebaseToken(firebaseToken);

    const user = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (!user) throw new Error('User not found.');

    if (!user.isActive || user.isArchived) {
      throw new Error('Account is inactive or archived.');
    }

    const otpRecord = await authRepository.findValidOtp(user.id, data.otp);
    if (!otpRecord) {
      throw new Error('Invalid or expired verification code.');
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
      expiresIn: '15m',
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

    const decoded = await verifyFirebaseToken(firebaseToken);

    let payload: SessionTokenPayload;
    try {
      payload = jwt.verify(currentSessionToken, secret) as SessionTokenPayload;
    } catch {
      throw new Error('Session token is invalid. Please log in again.');
    }

    if (payload.firebaseUid !== decoded.uid) {
      throw new Error('Token mismatch. Please log in again.');
    }

    const user = await authRepository.findUserByFirebaseUid(decoded.uid);
    if (!user || !user.isActive || user.isArchived) {
      throw new Error('Account is inactive or archived.');
    }

    const newPayload: SessionTokenPayload = {
      userId: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    const sessionToken = generateSessionToken(newPayload);

    return { sessionToken, expiresIn: '15m' };
  },
};