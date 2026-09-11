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
// ─────────────────────────────────────────
//  RATE LIMITER — MEMORY HUB PUBLIC GALLERY
//
//  Fully unauthenticated, and the token is meant to be shared widely
//  (family, group chats) — the most exposed endpoint on the platform.
//  The token itself is unguessable (32 random bytes, same as an invite
//  token), so this isn't really guarding against brute-forcing it; it's
//  guarding against scripted scraping/hammering once a real link leaks
//  somewhere unexpected. Keyed by IP (no authenticated user exists
//  here). 60 requests / 5 minutes is generous enough that a household
//  or venue Wi-Fi with several people browsing photos on one shared IP
//  is never affected, while bounding a script that has the token and
//  hits it in a tight loop.
// ─────────────────────────────────────────
export const memoryHubGalleryLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
        status: 'error',
        message: 'Too many requests. Please wait a few minutes and try again.',
    },
});
// ─────────────────────────────────────────
//  RATE LIMITER — MEMORY HUB GUEST UPLOAD SIGNATURE
//
//  Not explicitly requested by the batch prompt (only the public
//  gallery view was) but added for the same reason uploadSignatureLimiter
//  exists: every response is an upload grant, and this endpoint is
//  reachable with nothing but a valid invite token — no session, no
//  role check. Keyed by IP. 20 requests / 5 minutes comfortably covers
//  a guest uploading several photos/videos in one sitting while
//  bounding a script that has a leaked token and mints grants with it.
// ─────────────────────────────────────────
export const memoryHubGuestUploadLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
        status: 'error',
        message: 'Too many upload requests. Please wait a few minutes and try again.',
    },
});
// ─────────────────────────────────────────
//  RATE LIMITER — PUBLIC EVENT VIEW
//
//  Same exposure profile as memoryHubGalleryLimiter: fully
//  unauthenticated, reached with nothing but an unguessable shareToken
//  that's meant to be shared widely. Keyed by IP. Same 60/5min budget —
//  generous enough that several people on one shared IP browsing an
//  event page before registering is never affected, while bounding a
//  script hammering a leaked/guessed token.
// ─────────────────────────────────────────
export const publicEventViewLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
        status: 'error',
        message: 'Too many requests. Please wait a few minutes and try again.',
    },
});
// ─────────────────────────────────────────
//  RATE LIMITERS — PUBLIC EVENT REGISTRATION
//
//  Unlike every other limiter in this file, registration WRITES a
//  database row (Guest + Invite) on success — closer in risk to
//  uploadSignatureLimiter (every response is a grant) than to a read
//  endpoint, except here there's no session at all gating who can call
//  it. Two limiters stacked, keyed differently, because they guard
//  against different abuse shapes:
//
//  Per IP — a genuine registrant submits once, maybe a couple of times
//  if they mistype their contact and get a validation error back. 8 per
//  15 minutes comfortably covers that (plus a shared-IP household
//  registering a couple of people back to back) while making a
//  single-machine script mass-registering fake guests impractical.
//
//  Per event (keyed by the shareToken in the URL, not the IP) — a
//  script distributed across many IPs would sail through the IP limiter
//  above untouched, so this is the actual backstop against "thousands
//  of fake guests" on one popular link. The window is deliberately
//  short and the ceiling deliberately generous (30/minute = up to 1800/
//  hour if sustained) specifically because a link just dropped into a
//  busy WhatsApp group can legitimately produce a burst of real
//  registrations from different people within seconds of each other —
//  a tight per-event limit would reject genuine guests during exactly
//  the moment the feature is supposed to shine. This is a pace guard
//  against a sustained script, not a hard ceiling on total
//  registrations — SubscriptionTierConfig.maxGuestsPerEvent
//  (guest-tier-enforcement.util.ts) is what actually bounds the total
//  for tiers that have a cap; for unlimited tiers this is the only
//  brake, and a patient, low-and-slow attacker could still get through
//  it over time — same tradeoff addressLimiter's own comment already
//  accepts for that endpoint (a script-abuse guard, not a hard
//  ceiling).
// ─────────────────────────────────────────
export const publicRegistrationIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
        status: 'error',
        message: 'Too many registration attempts. Please wait a few minutes and try again.',
    },
});
export const publicRegistrationEventLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `event:${req.params['shareToken'] ?? 'unknown'}`,
    message: {
        status: 'error',
        message: 'Registration for this event is receiving a high volume of requests right now. Please try again in a moment.',
    },
});
//# sourceMappingURL=rate-limit.middleware.js.map