import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { HttpError } from './shared/errors/http-error.js';

// ─────────────────────────────────────────
//  ROUTERS
// ─────────────────────────────────────────
import tenantRouter from './modules/tenant/tenant.router.js';
import userRouter from './modules/user/user.router.js';
import eventRouter from './modules/event/event.router.js';
import eventDayRouter from './modules/event-day/event-day.router.js';
import eventDraftRouter from './modules/event-draft/event-draft.router.js';
import guestRouter from './modules/guest/guest.router.js';
import guestEventRouter from './modules/guest/guest-event.router.js';
import inviteRouter from './modules/invite/invite.router.js';
import attendanceRouter from './modules/attendance/attendance.router.js';
import authRouter from './modules/auth/auth.router.js';
import memoryHubRouter from './modules/memory-hub/memory-hub.router.js';
import memoryHubPublicRouter from './modules/memory-hub/memory-hub-public.router.js';
import vendorRouter from './modules/vendor/vendor.router.js';
import subscriptionTierConfigRouter from './modules/subscription-tier-config/subscription-tier-config.router.js';
import rsvpFieldRouter from './modules/rsvp-field/rsvp-field.router.js';
import rsvpResponseRouter from './modules/rsvp-response/rsvp-response.router.js';
import eventProgramRouter from './modules/event-program/event-program.router.js';
import programItemRouter from './modules/program-item/program-item.router.js';
import ticketRouter from './modules/ticket/ticket.router.js';
import ticketPurchaseRouter from './modules/ticket-purchase/ticket-purchase.router.js';
import rsvpRouter from './modules/rsvp/rsvp.router.js';
import geocodingRouter from './modules/geocoding/geocoding.router.js';

const app: Application = express();

// ─────────────────────────────────────────
//  TRUST PROXY
//  Render terminates TLS and proxies every
//  request through one hop before it reaches
//  this app, so Express doesn't see the real
//  client IP by default. `1` trusts exactly
//  that one hop when resolving X-Forwarded-For
//  into req.ip — must be set before any
//  middleware that reads req.ip (rate limiters
//  included). `true` is deliberately avoided:
//  it trusts the entire X-Forwarded-For chain,
//  which a client could pad with spoofed
//  entries.
// ─────────────────────────────────────────
app.set('trust proxy', 1);

// ─────────────────────────────────────────
//  CORS
//  Env-driven allowlist. Requests with no
//  Origin header (Postman, curl, server-to-
//  server) are always allowed through — only
//  browser cross-origin requests carry Origin.
// ─────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: false,
  // Without this, the browser can't read Content-Disposition on a
  // cross-origin response — the guest-import template download falls
  // back to a generic filename instead of the event-specific one the
  // backend actually sets.
  exposedHeaders: ['Content-Disposition'],
}));

// ─────────────────────────────────────────
//  BODY PARSERS
// ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'EventGenie API',
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────
//  ROUTES
//
//  Nested routers (event-day, invite) are
//  mounted under their parent event route
//  so that :eventId is available via
//  mergeParams in the child router.
//
//  Route structure:
//  /api/tenants
//  /api/users
//  /api/events
//  /api/events/:eventId/days
//  /api/events/:eventId/guests
//  /api/events/:eventId/invites
//  /api/events/:eventId/rsvp-fields
//  /api/events/:eventId/program
//  /api/events/:eventId/program/:programId/items
//  /api/events/:eventId/tickets
//  /api/events/:eventId/memory-hub
//  /api/event-drafts/current
//  /api/invites/:inviteId/rsvp-responses
//  /api/ticket-purchases
//  /api/memory-hub (public view by shareToken)
//  /api/rsvp (public — validate/:token, submit)
//  /api/guests
//  /api/attendance
//  /api/vendors
//  /api/geocoding (address search — HERE proxy)
// ─────────────────────────────────────────
app.use('/api/tenants', tenantRouter);
app.use('/api/users', userRouter);
app.use('/api/guests', guestRouter);
app.use('/api/attendance', attendanceRouter);

// Event router with nested children
app.use('/api/events', eventRouter);
app.use('/api/events/:eventId/days', eventDayRouter);
app.use('/api/events/:eventId/guests', guestEventRouter);
app.use('/api/events/:eventId/invites', inviteRouter);
app.use('/api/events/:eventId/rsvp-fields', rsvpFieldRouter);
app.use('/api/events/:eventId/program', eventProgramRouter);
app.use('/api/events/:eventId/program/:programId/items', programItemRouter);
app.use('/api/events/:eventId/tickets', ticketRouter);
app.use('/api/event-drafts', eventDraftRouter);
app.use('/api/invites/:inviteId/rsvp-responses', rsvpResponseRouter);
app.use('/api/ticket-purchases', ticketPurchaseRouter);

// ─────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────
app.use('/api/auth', authRouter);

// ─────────────────────────────────────────
//  MEMORY HUB ROUTES
// ─────────────────────────────────────────
app.use('/api/events/:eventId/memory-hub', memoryHubRouter);
app.use('/api/memory-hub', memoryHubPublicRouter);

// ─────────────────────────────────────────
//  VENDOR ROUTES
// ─────────────────────────────────────────
app.use('/api/vendors', vendorRouter);
//  ────────────────────────────────────────
//  SUBSCRIPTION TIER CONFIG ROUTES
//  ────────────────────────────────────────
app.use('/api/subscription-tiers', subscriptionTierConfigRouter);

// ─────────────────────────────────────────
//  RSVP ROUTES (public — no auth)
// ─────────────────────────────────────────
app.use('/api/rsvp', rsvpRouter);

// ─────────────────────────────────────────
//  GEOCODING ROUTES (authenticated, not tenant-scoped)
// ─────────────────────────────────────────
app.use('/api/geocoding', geocodingRouter);
// ─────────────────────────────────────────
//  404 HANDLER
// ─────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: 'Route not found',
  });
});

// ─────────────────────────────────────────
//  GLOBAL ERROR HANDLER
//  Shows full error in dev, hides in prod.
// ─────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[ERROR] ${err.message}`);

  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      ...(err.code !== undefined && { code: err.code }),
    });
    return;
  }

  res.status(500).json({
    status: 'error',
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
  });
});

export default app;