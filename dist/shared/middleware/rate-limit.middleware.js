import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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
// ─────────────────────────────────────────
//  RATE LIMITER — GEOCODING AUTOSUGGEST
//
//  Fires per keystroke while an organiser types an address (debounced
//  on the frontend, but that's not a guarantee this backend can rely
//  on), and every call spends against HERE's monthly free-tier quota.
//  Keyed by authenticated user id (route requires `authenticate`
//  first), not IP — two organisers on the same office network shouldn't
//  share a bucket. 20 requests/minute comfortably covers even an
//  undebounced full address (typically 3-8 calls per address typed with
//  debounce, more like 15-20 without it) while stopping a runaway
//  script from burning quota at speed. Note: this only throttles a
//  single actor — it doesn't cap aggregate usage across all tenants, so
//  it's a script-abuse guard, not a hard ceiling on the monthly quota.
// ─────────────────────────────────────────
export const addressAutosuggestLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
        status: 'error',
        message: 'Too many address searches — please slow down and try again shortly.',
    },
});
// ─────────────────────────────────────────
//  RATE LIMITER — UPLOAD SIGNATURE
//
//  Cheap to call, but every successful response is a grant to upload
//  into this tenant's Cloudinary folder — unlike a search result, it's
//  not just information, it's permission. Keyed by user id (route
//  requires `authenticate`). 10 requests / 5 minutes comfortably covers
//  real editing (trying a few different cover images before deciding)
//  while making it impractical to mint a large number of upload grants
//  in a short window.
// ─────────────────────────────────────────
export const uploadSignatureLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
        status: 'error',
        message: 'Too many upload requests. Please wait a few minutes and try again.',
    },
});
//# sourceMappingURL=rate-limit.middleware.js.map