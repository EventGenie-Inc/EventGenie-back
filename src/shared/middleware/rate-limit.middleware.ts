import rateLimit from 'express-rate-limit';

// ─────────────────────────────────────────
//  RATE LIMITERS — AUTH ENDPOINTS
//
//  Purpose-specific limiters, not one generic
//  one — each endpoint has a different risk
//  profile. In-memory store (express-rate-limit
//  default): valid only as long as this backend
//  runs as a single instance. If it's ever scaled
//  horizontally, swap in a shared store (e.g.
//  rate-limit-redis) or the limits become
//  per-instance and effectively looser than
//  configured.
// ─────────────────────────────────────────

// Forgot password — most sensitive, no auth barrier at all.
// Keyed by IP (default). Deliberately strict.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many password reset requests. Please try again later.',
  },
});

// Forgot password — second layer, keyed by the submitted email
// rather than IP. Guards against a targeted-harassment scenario
// (repeatedly triggering real reset emails to one victim from
// varied IPs, which the IP limiter above wouldn't catch). Uses the
// same response message as the IP limiter so a 429 here reveals
// nothing about whether the email is real vs. just IP-rate-limited.
export const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body?.email ?? 'unknown').toLowerCase().trim(),
  message: {
    status: 'error',
    message: 'Too many password reset requests. Please try again later.',
  },
});

// Request OTP — Firebase-token-authenticated but still limited,
// to prevent inbox-spamming a real account (stolen token, or just
// repeated calls).
export const requestOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many verification code requests. Please try again later.',
  },
});

// Verify OTP — allow enough attempts for genuine typos, but cap
// well below what makes brute-forcing a 6-digit code practical.
export const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many verification attempts. Please request a new code.',
  },
});
