import { Router, type Request, type Response, type NextFunction } from 'express';
import { authService } from './auth.service.js';
import {
  type RegisterDto,
  type VerifyOtpDto,
  type ForgotPasswordDto,
  type ExchangeSessionDto,
  type LogoutDto,
} from './auth.types.js';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  forgotPasswordLimiter,
  forgotPasswordEmailLimiter,
  requestOtpLimiter,
  verifyOtpLimiter,
  exchangeSessionLimiter,
  exchangeSessionDeviceLimiter,
  logoutLimiter,
} from '../../shared/middleware/rate-limit.middleware.js';

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
router.post('/request-otp', requestOtpLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
router.post('/verify-otp', verifyOtpLimiter, async (req: Request, res: Response, next: NextFunction) => {
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

// ─────────────────────────────────────────
//  POST /api/auth/exchange-session
//  Headers: Authorization: Bearer <firebase_token>
//  Body: { deviceToken: string }
//  Trusted Devices — mints a session JWT from a Firebase ID token plus a
//  device token that already passed an OTP on THIS device. No OTP here;
//  see auth.service.ts's exchangeSession for why a Firebase token alone
//  is never enough.
// ─────────────────────────────────────────
router.post('/exchange-session', exchangeSessionLimiter, exchangeSessionDeviceLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const firebaseToken = extractBearerToken(req);
    const body = req.body as ExchangeSessionDto;

    if (!body.deviceToken) {
      res.status(400).json({
        status: 'error',
        message: 'deviceToken is required',
      });
      return;
    }

    const result = await authService.exchangeSession(firebaseToken, body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  POST /api/auth/logout
//  Body: { deviceToken: string }
//  Explicit, voluntary sign-out — revokes the device token, so this
//  device needs a fresh OTP next time. No Authorization header required:
//  this must work even if the Firebase/session state on the client is
//  already unusable. Always 200 — see auth.service.ts's logout.
// ─────────────────────────────────────────
router.post('/logout', logoutLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as LogoutDto;

    if (!body.deviceToken) {
      res.status(400).json({
        status: 'error',
        message: 'deviceToken is required',
      });
      return;
    }

    const result = await authService.logout(body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  POST /api/auth/forgot-password
//  Body: { email: string }
//  No auth headers — reachable while logged out.
//  Always returns the same generic response,
//  regardless of whether the email exists.
// ─────────────────────────────────────────
router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordEmailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as ForgotPasswordDto;

    if (!body.email) {
      throw new HttpError(400, 'email is required');
    }

    const result = await authService.forgotPassword(body.email);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;