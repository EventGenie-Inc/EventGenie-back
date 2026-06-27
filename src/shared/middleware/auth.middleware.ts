import { getAuth } from 'firebase-admin/auth';
import { type Request, type Response, type NextFunction } from 'express';
import { firebaseAdmin } from '../firebase/firebase.admin.js';
import { prisma} from '../prisma/prisma.client.js'

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
      };
    }
  }
}

// ─────────────────────────────────────────
//  AUTH MIDDLEWARE
//
//  Layer 1 — applied to ALL protected routes.
//
//  Flow:
//  1. Extract Bearer token from Authorization header
//  2. Verify token with Firebase Admin SDK
//  3. Look up the user in Postgres by firebaseUid
//  4. Attach user to req.user for downstream use
//  5. Reject if token is missing, invalid, or user
//     does not exist in the platform database
// ─────────────────────────────────────────
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        status: 'error',
        message: 'Missing or malformed Authorization header',
      });
      return;
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      res.status(401).json({
        status: 'error',
        message: 'No token provided',
      });
      return;
    }

    // Verify with Firebase Admin SDK
    const decoded = await getAuth(firebaseAdmin).verifyIdToken(token);

    // Look up user in Postgres
    const user = await prisma.user.findUnique({
      where: { firebaseUid: decoded.uid },
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        role: true,
        tenantId: true,
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

    // Attach to request for downstream use
    req.user = {
      id: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };

    next();
  } catch (error) {
    const err = error as Error;

    // Firebase throws specific error codes we can handle gracefully
    if (
      err.message.includes('auth/id-token-expired') ||
      err.message.includes('auth/argument-error') ||
      err.message.includes('auth/id-token-revoked')
    ) {
      res.status(401).json({
        status: 'error',
        message: 'Token is invalid or has expired',
      });
      return;
    }

    next(error);
  }
};