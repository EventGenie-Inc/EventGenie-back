import {} from 'express';
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
export const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({
                status: 'error',
                message: 'Not authenticated',
            });
            return;
        }
        const userRole = req.user.role;
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
export const requireTenantAdmin = requireRole(PlatformRole.SUPER_ADMIN, PlatformRole.TENANT_ADMIN);
// Any authenticated platform user
export const requireEventAdmin = requireRole(PlatformRole.SUPER_ADMIN, PlatformRole.TENANT_ADMIN, PlatformRole.EVENT_ADMIN);
// Platform owner, tenant admin, or a vendor managing their own space
export const requireVendor = requireRole(PlatformRole.SUPER_ADMIN, PlatformRole.TENANT_ADMIN, PlatformRole.EVENT_VENDOR);
// Event admins plus vendors (read-only marketplace/event visibility surface)
export const requireEventAdminOrVendor = requireRole(PlatformRole.SUPER_ADMIN, PlatformRole.TENANT_ADMIN, PlatformRole.EVENT_ADMIN, PlatformRole.EVENT_VENDOR);
// ─────────────────────────────────────────
//  Ownership-aware guard for vendor self-service.
//  SUPER_ADMIN / TENANT_ADMIN always pass.
//  EVENT_VENDOR passes only if their own
//  vendorSpaceId matches the route param.
//
//  Usage:
//  router.put('/:id', authenticate, requireVendorSpaceOwner('id'), controller)
// ─────────────────────────────────────────
export const requireVendorSpaceOwner = (paramName) => {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({
                status: 'error',
                message: 'Not authenticated',
            });
            return;
        }
        const userRole = req.user.role;
        if (userRole === PlatformRole.SUPER_ADMIN || userRole === PlatformRole.TENANT_ADMIN) {
            next();
            return;
        }
        if (userRole === PlatformRole.EVENT_VENDOR && req.user.vendorSpaceId === req.params[paramName]) {
            next();
            return;
        }
        res.status(403).json({
            status: 'error',
            message: 'You do not have permission to access this resource',
        });
    };
};
//# sourceMappingURL=role.middleware.js.map