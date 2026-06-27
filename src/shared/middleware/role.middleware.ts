import { type Request, type Response, type NextFunction } from 'express';
import { PlatformRole } from '@prisma/client';

// ─────────────────────────────────────────
//  ROLE MIDDLEWARE
//
//  Layer 2 — applied to specific routes
//  AFTER the authenticate middleware.
//
//  Usage:
//  router.get(
//    '/admin/tenants',
//    authenticate,
//    requireRole(PlatformRole.SUPER_ADMIN),
//    controller
//  );
//
//  Multiple roles can be passed:
//  requireRole(PlatformRole.SUPER_ADMIN, PlatformRole.TENANT_ADMIN)
// ─────────────────────────────────────────
export const requireRole = (...allowedRoles: PlatformRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        status: 'error',
        message: 'Not authenticated',
      });
      return;
    }

    const userRole = req.user.role as PlatformRole;

    if (!allowedRoles.includes(userRole)) {
      res.status(403).json({
        status: 'error',
        message: 'You do not have permission to access this resource',
      });
      return;
    }

    next();
  };
};

// ─────────────────────────────────────────
//  CONVENIENCE GUARDS
//
//  Pre-composed role checks for the most
//  common access patterns across the platform.
//  Import and use directly on routes.
// ─────────────────────────────────────────

// Only the platform owner
export const requireSuperAdmin = requireRole(PlatformRole.SUPER_ADMIN);

// Platform owner or tenant admin
export const requireTenantAdmin = requireRole(
  PlatformRole.SUPER_ADMIN,
  PlatformRole.TENANT_ADMIN
);

// Any authenticated platform user
export const requireEventAdmin = requireRole(
  PlatformRole.SUPER_ADMIN,
  PlatformRole.TENANT_ADMIN,
  PlatformRole.EVENT_ADMIN
);