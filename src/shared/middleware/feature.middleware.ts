import { type Request, type Response, type NextFunction } from 'express';
import { PlatformRole } from '@prisma/client';
import { isFeatureEnabled, type FeatureName } from '../features/feature-flags.js';

// The global 404 handler's body (app.ts). A switched-off feature's route
// answers with exactly this, so it can't be told apart from a route that
// doesn't exist.
export const ROUTE_NOT_FOUND_BODY = { status: 'error', message: 'Route not found' } as const;

// ─────────────────────────────────────────
//  FEATURE GUARD
//
//  The one place a switched-off feature is enforced on the server: applied
//  once per router (router.use) or per route, never as checks inside
//  services. Off means 404 for everyone except SUPER_ADMIN, the same way a
//  role gate hides a page rather than showing it locked.
//
//  On an authenticated router it goes AFTER authenticate (it needs
//  req.user to let a SUPER_ADMIN through) and BEFORE the role gate, so a
//  caller without the role gets the same 404 as everyone else, not a 403
//  that confirms the route exists. On a public route there is no user, so
//  off is a 404 for every caller.
// ─────────────────────────────────────────
export const requireFeature = (feature: FeatureName) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (isFeatureEnabled(feature) || req.user?.role === PlatformRole.SUPER_ADMIN) {
      next();
      return;
    }
    res.status(404).json(ROUTE_NOT_FOUND_BODY);
  };
