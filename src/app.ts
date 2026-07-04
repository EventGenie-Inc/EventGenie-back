import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';

// ─────────────────────────────────────────
//  ROUTERS
// ─────────────────────────────────────────
import tenantRouter from './modules/tenant/tenant.router.js';
import userRouter from './modules/user/user.router.js';
import eventRouter from './modules/event/event.router.js';
import eventDayRouter from './modules/event-day/event-day.router.js';
import guestRouter from './modules/guest/guest.router.js';
import inviteRouter from './modules/invite/invite.router.js';
import attendanceRouter from './modules/attendance/attendance.router.js';
import authRouter from './modules/auth/auth.router.js';
import memoryHubRouter from './modules/memory-hub/memory-hub.router.js';
import vendorRouter from './modules/vendor/vendor.router.js';
import subscriptionTierConfigRouter from './modules/subscription-tier-config/subscription-tier-config.router.js';


// ─────────────────────────────────────────
//  Remaining routers registered as built:
//  import authRouter from './modules/auth/auth.router.js';
//  import memoryHubRouter from './modules/memory-hub/memory-hub.router.js';
//  import vendorRouter from './modules/vendor/vendor.router.js';
// ─────────────────────────────────────────

const app: Application = express();

// ─────────────────────────────────────────
//  CORS
//  Open for now. When frontend URL is known,
//  replace with: origin: process.env.FRONTEND_URL
// ─────────────────────────────────────────
app.use(cors());

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
//  /api/events/:eventId/invites
//  /api/guests
//  /api/attendance
// ─────────────────────────────────────────
app.use('/api/tenants', tenantRouter);
app.use('/api/users', userRouter);
app.use('/api/guests', guestRouter);
app.use('/api/attendance', attendanceRouter);

// Event router with nested children
app.use('/api/events', eventRouter);
app.use('/api/events/:eventId/days', eventDayRouter);
app.use('/api/events/:eventId/invites', inviteRouter);

// ─────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────
app.use('/api/auth', authRouter);

// ─────────────────────────────────────────
//  MEMORY HUB ROUTES
// ─────────────────────────────────────────
app.use('/api/events/:eventId/memory-hub', memoryHubRouter);

// ─────────────────────────────────────────
//  VENDOR ROUTES
// ─────────────────────────────────────────
app.use('/api/vendors', vendorRouter);
//  ────────────────────────────────────────
//  SUBSCRIPTION TIER CONFIG ROUTES
//  ────────────────────────────────────────
app.use('/api/subscription-tiers', subscriptionTierConfigRouter);
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

  res.status(500).json({
    status: 'error',
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message,
  });
});

export default app;