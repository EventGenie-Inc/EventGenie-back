import { Router, type Request, type Response, type NextFunction } from 'express';
import { authService } from './auth.service.js';
import { type RegisterDto, type VerifyOtpDto } from './auth.types.js';
import { HttpError } from '../../shared/errors/http-error.js';

const router = Router();

// ─────────────────────────────────────────
//  All auth routes extract the Firebase
//  token from the Authorization header
//  and pass it to the service layer.
//  No authenticate middleware here —
//  the service verifies Firebase directly
//  since not all users exist in Postgres yet.
// ─────────────────────────────────────────

const extractBearerToken = (req: Request): string => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or malformed Authorization header');
  }
  const token = authHeader.split(' ')[1];
  if (!token) throw new HttpError(401, 'No token provided');
  return token;
};

// ─────────────────────────────────────────
//  POST /api/auth/register
//  Body: { username, tenantName, tenantSlug }
//  Creates Tenant + TENANT_ADMIN in one tx.
// ─────────────────────────────────────────
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const firebaseToken = extractBearerToken(req);
    const body = req.body as RegisterDto;

    if (!body.username || !body.tenantName || !body.tenantSlug) {
      res.status(400).json({
        status: 'error',
        message: 'username, tenantName, and tenantSlug are required',
      });
      return;
    }

    const result = await authService.register(firebaseToken, body);
    res.status(201).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  POST /api/auth/request-otp
//  Generates and emails a 6-digit OTP.
//  User must exist in Postgres.
// ─────────────────────────────────────────
router.post('/request-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const firebaseToken = extractBearerToken(req);
    const result = await authService.requestOtp(firebaseToken);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  POST /api/auth/verify-otp
//  Body: { otp: "123456" }
//  Validates OTP and returns session JWT.
// ─────────────────────────────────────────
router.post('/verify-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const firebaseToken = extractBearerToken(req);
    const body = req.body as VerifyOtpDto;

    if (!body.otp) {
      res.status(400).json({
        status: 'error',
        message: 'otp is required',
      });
      return;
    }

    const result = await authService.verifyOtp(firebaseToken, body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  POST /api/auth/refresh-session
//  Headers: Authorization: Bearer <firebase_token>
//           X-Session-Token: <current_jwt>
//  Issues a fresh 15min session JWT.
// ─────────────────────────────────────────
router.post('/refresh-session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const firebaseToken = extractBearerToken(req);
    const currentSessionToken = req.headers['x-session-token'] as string;

    if (!currentSessionToken) {
      throw new HttpError(401, 'X-Session-Token header is required');
    }

    const result = await authService.refreshSession(firebaseToken, currentSessionToken);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;