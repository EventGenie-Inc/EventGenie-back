import jwt from 'jsonwebtoken';
import { getAuth } from 'firebase-admin/auth';
import { type Request, type Response, type NextFunction } from 'express';
import { firebaseAdmin } from '../firebase/firebase.admin.js';
import { prisma } from '../prisma/prisma.client.js';
import { type SessionTokenPayload } from '../../modules/auth/auth.types.js';

// ─────────────────────────────────────────
//  Extend Express Request to carry the
//  verified user throughout the request
//  lifecycle. Available in all downstream
//  handlers and middleware.
// ─────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        firebaseUid: string;
        email: string;
        role: string;
        tenantId: string | null;
        vendorSpaceId: string | null;
      };
    }
  }
}

// ─────────────────────────────────────────
//  AUTH MIDDLEWARE
//
//  Two-layer verification on every
//  protected route:
//
//  Layer 1 — Firebase ID token
//    Proves the user is authenticated
//    with Firebase (identity provider).
//
//  Layer 2 — Session JWT
//    Proves the user completed 2FA
//    (OTP verification) in this session.
//    Sent via X-Session-Token header.
//
//  Both must be valid. Either failing
//  results in a 401.
// ─────────────────────────────────────────
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {

    // ── Layer 1: Firebase ID Token ────────
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        status: 'error',
        message: 'Missing or malformed Authorization header',
      });
      return;
    }

    const firebaseToken = authHeader.split(' ')[1];

    if (!firebaseToken) {
      res.status(401).json({
        status: 'error',
        message: 'No Firebase token provided',
      });
      return;
    }

    // Verify Firebase token
    const decoded = await getAuth(firebaseAdmin).verifyIdToken(firebaseToken);

    // ── Layer 2: Session JWT ──────────────
    const sessionToken = req.headers['x-session-token'] as string | undefined;

    if (!sessionToken) {
      res.status(401).json({
        status: 'error',
        message: 'Missing X-Session-Token header. Please complete 2FA verification.',
      });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is not defined in .env');

    let sessionPayload: SessionTokenPayload;
    try {
      sessionPayload = jwt.verify(sessionToken, jwtSecret) as SessionTokenPayload;
    } catch (jwtError) {
      const err = jwtError as Error;

      // Distinguish between expired and invalid
      if (err.name === 'TokenExpiredError') {
        res.status(401).json({
          status: 'error',
          message: 'Session has expired. Please refresh your session.',
          code: 'SESSION_EXPIRED',
        });
        return;
      }

      res.status(401).json({
        status: 'error',
        message: 'Invalid session token. Please log in again.',
        code: 'SESSION_INVALID',
      });
      return;
    }

    // Ensure Firebase UID matches the session payload —
    // prevents token substitution attacks
    if (sessionPayload.firebaseUid !== decoded.uid) {
      res.status(401).json({
        status: 'error',
        message: 'Token mismatch. Please log in again.',
      });
      return;
    }

    // ── Postgres User Lookup ──────────────
    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        role: true,
        tenantId: true,
        vendorSpaceId: true,
        isActive: true,
        isArchived: true,
      },
    });

    if (!user) {
      res.status(401).json({
        status: 'error',
        message: 'User not found in platform',
      });
      return;
    }

    if (!user.isActive || user.isArchived) {
      res.status(403).json({
        status: 'error',
        message: 'Account is inactive or has been archived',
      });
      return;
    }

    // ── Attach to Request ─────────────────
    req.user = {
      id: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      vendorSpaceId: user.vendorSpaceId,
    };

    next();
  } catch (error) {
    // Firebase Admin errors carry the reason in `.code` (e.g. 'auth/id-token-expired'),
    // not in `.message` — the human-readable message never contains these strings.
    const err = error as { code?: string; message: string };

    if (
      err.code === 'auth/id-token-expired' ||
      err.code === 'auth/argument-error' ||
      err.code === 'auth/id-token-revoked'
    ) {
      res.status(401).json({
        status: 'error',
        message: 'Firebase token is invalid or has expired',
      });
      return;
    }

    next(error);
  }
};