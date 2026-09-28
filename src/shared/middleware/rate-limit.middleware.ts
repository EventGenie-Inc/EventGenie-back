import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { hashToken } from '../../modules/auth/device-token.util.js';
import { MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN } from '../../modules/upload/upload-constants.js';

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
//  RATE LIMITERS — TRUSTED DEVICES (exchange-session / logout)
//
//  exchange-session is public (no session token exists yet — that's the
//  entire point) and, by design, called on every ordinary page load, not
//  just at login — closer in call pattern to a hot read endpoint than to
//  request-otp/verify-otp above. The device token itself is 256 random
//  bits (device-token.util.ts) — brute-forcing the VALUE is infeasible
//  regardless of any rate limit reachable here — so these two limiters
//  guard against different, more realistic costs instead: hammering the
//  endpoint's own Firebase Admin SDK call (verifyIdToken with
//  checkRevoked is a real round trip to Google, a genuine per-request
//  cost, not free like checking a JWT signature locally), and bounding
//  how many attempts one specific device-token VALUE gets regardless of
//  how many different IPs try it (the IP limiter alone wouldn't catch a
//  credential — stolen or merely guessed — being hammered from many
//  sources).
//
//  Both count ONLY FAILED attempts (skipSuccessfulRequests) — Trusted
//  Devices Hardening batch. The job of both limiters is stopping
//  guessing/abuse, and guessing is failures by definition; a successful
//  exchange is exactly the endpoint working as designed, on a path every
//  ordinary page load takes. Counting successes against the SAME budget
//  as failures meant legitimate multi-tab use (several tabs re-minting
//  around the same time) could exhaust exchangeSessionDeviceLimiter's
//  budget on its own, and — the sharper problem — South African mobile
//  networks put many unrelated users behind one shared carrier-grade NAT
//  IP, so exchangeSessionLimiter's 30/5min counting successes could
//  throttle unrelated real users the moment routine traffic from that
//  shared IP passed 30 successful exchanges in five minutes, nothing to
//  do with abuse. With only failures counted, ordinary successful use —
//  the overwhelming majority of real traffic on this endpoint — never
//  touches the budget at all, on both limiters; 30/5min is kept as the
//  number precisely because it now only has to be generous against a
//  burst of FAILURES, a rarer and more attack-indicative signal, not
//  against however much legitimate volume a shared IP produces.
// ─────────────────────────────────────────
export const exchangeSessionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: {
    status: 'error',
    message: 'Too many session requests. Please wait a few minutes and try again.',
  },
});

// Keyed by the SHA-256 hash of the submitted device token, never the raw
// value — the same hash device-token.util.ts stores in the database,
// via the same exported hashToken, so this in-memory bucket never holds
// a live credential as a literal key for the length of the rate-limit
// window. Extracted as its own named export (rather than inlined in the
// rateLimit() call below) so a test can call it directly and assert it
// never contains the raw token — see tests/auth/rate-limit.test.ts.
export const deviceLimiterKey = (rawDeviceToken: string): string => `device:${hashToken(rawDeviceToken)}`;

export const exchangeSessionDeviceLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => deviceLimiterKey((req.body?.deviceToken ?? 'unknown') as string),
  message: {
    status: 'error',
    message: 'Too many session requests for this device. Please wait a few minutes and try again.',
  },
});

// Logout — low legitimate volume (one explicit click), low risk (it can
// only ever revoke a token the caller already possesses — see
// auth.service.ts's logout). Generous ceiling exists purely as a basic
// backstop against a scripted loop, not because the action itself is
// sensitive.
export const logoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: {
    status: 'error',
    message: 'Too many requests. Please wait a few minutes and try again.',
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
//  RATE LIMITER — MEMORY HUB GUEST UPLOAD SIGNATURE / GUEST ITEMS
//
//  Every response is an upload grant, and this endpoint is reachable
//  with nothing but a valid invite token — no session, no role check.
//
//  Originally keyed purely by IP, which is wrong for exactly the reason
//  the auth rate limiters above are not: guests at the same venue WiFi,
//  or on South African mobile networks behind one shared carrier-grade
//  NAT IP, all present as ONE IP — an entire wedding shared a single
//  ~10-photos-per-5-minutes budget under the old 20/5min-per-IP scheme,
//  nothing to do with abuse.
//
//  Two limiters now, stacked, each guarding a different shape of abuse:
//
//  memoryHubGuestUploadLimiter — the real per-guest-invite budget.
//  Keyed by the SHA-256 hash of the invite TOKEN from the request body
//  (memoryHubGuestUploadTokenKey, exported so a test can assert the raw
//  token never appears as a key — same reasoning as deviceLimiterKey
//  above: a rate limiter's own in-memory store must not hold a live
//  credential as a literal object key). 60 requests / 5 minutes per
//  invite comfortably covers one guest uploading many photos/videos in
//  a single sitting, and — because it is per INVITE, not per IP — is
//  completely unaffected by how many other guests share the same
//  network.
//
//  memoryHubGuestUploadIpLimiter — the abuse backstop the per-invite
//  limiter alone can't provide (a script that mints a fresh/guessed
//  token per request would get a fresh per-invite budget every time).
//  Counts ONLY FAILED attempts (skipSuccessfulRequests — same
//  reasoning as exchangeSessionLimiter: a real, successful upload from
//  a busy shared IP must never count against this). 100 failed
//  requests / 5 minutes per IP is deliberately generous — even a large
//  venue with dozens of guests hitting occasional real errors
//  (an expired link, a duplicate tap) at once should never approach it,
//  while a script hammering invalid/guessed tokens from one IP still
//  hits a real ceiling.
//
//  guest-view's `limits.uploadRequestsPer5Min` (memory-hub.service.ts's
//  getGuestView) reports this limiter's own `max` so the frontend never
//  hardcodes the number and reads whatever this file actually enforces.
// ─────────────────────────────────────────
export const memoryHubGuestUploadTokenKey = (rawToken: string): string => `memory-hub-invite:${hashToken(rawToken)}`;

export const memoryHubGuestUploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: MEMORY_HUB_GUEST_UPLOAD_REQUESTS_PER_5_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => memoryHubGuestUploadTokenKey((req.body?.token ?? 'unknown') as string),
  message: {
    status: 'error',
    message: 'Too many upload requests. Please wait a few minutes and try again.',
  },
});

export const memoryHubGuestUploadIpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: {
    status: 'error',
    message: 'Too many requests from this network. Please wait a few minutes and try again.',
  },
});

// ─────────────────────────────────────────
//  RATE LIMITER — GUEST PROGRAM VIEW (POST /api/rsvp/program)
//
//  Unauthenticated, token-only — same exposure profile as
//  ticketQuoteLimiter (an invite token, not a session), but this fires
//  once per page load/tab-open rather than per keystroke/quantity
//  change. Deliberately its own limiter, not shared with any upload
//  budget — this is a pure read. Keyed by IP. 60/5min mirrors
//  memoryHubGalleryLimiter/publicEventViewLimiter's "page load" budget.
// ─────────────────────────────────────────
export const rsvpProgramLimiter = rateLimit({
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
//  RATE LIMITER — MEMORY HUB GUEST VIEW (POST /api/memory-hub/guest-view)
//
//  Unauthenticated, token-only, fired once per page load to decide
//  whether to show the Memory Hub tab at all — a pure read, unlike
//  memoryHubGuestUploadLimiter (every response there is an upload
//  grant). Deliberately separate from that per-invite upload budget so
//  opening the page never eats into it. Keyed by IP; same 60/5min
//  "page load" budget as memoryHubGalleryLimiter.
// ─────────────────────────────────────────
export const memoryHubGuestViewLimiter = rateLimit({
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

// Ticket quotes are public-token reads that fire when a guest changes
// quantity. Thirty a minute leaves room for a mobile UI's debounced
// adjustments and a shared venue Wi-Fi, while preventing a leaked invite
// link from becoming a tight-loop source of configuration-derived pricing.
export const ticketQuoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: {
    status: 'error',
    message: 'Too many ticket price requests. Please wait a moment and try again.',
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
