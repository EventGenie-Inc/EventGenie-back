import {} from 'express';
import { PlatformRole } from '@prisma/client';
import prisma from '../prisma/prisma.client.js';
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
//
//  A security audit found the previous version of this function
//  ineffective: it passed EVERY TENANT_ADMIN through unconditionally,
//  without checking that the vendor space in the route param actually
//  belongs to that admin's tenant — a Tenant B admin could pass this
//  guard on Tenant A's vendor space. Fixed here by actually looking the
//  space up and comparing tenantId, same as every other module's
//  tenant-scoping (event.service.ts's getById, etc.) — this is the one
//  role-middleware in the codebase that needs to be DB-aware to do that,
//  same as authenticate() in this same directory already is.
//
//  SUPER_ADMIN always passes (that's the role's purpose — no tenant of
//  its own to check against).
//  TENANT_ADMIN passes only if the space belongs to their own tenant.
//  EVENT_VENDOR passes only if they are a MEMBER of the space in the
//  route param — checked through the VendorSpaceUser join table
//  (Vendor Space Follow-up batch: a vendor user can now belong to
//  several spaces, so this can no longer be a single-FK comparison) —
//  AND that space isn't archived (an archived space's own EVENT_VENDOR
//  member shouldn't be able to act on it — restoring it is a
//  tenant-admin-level action, see vendor.router.ts's reactivate routes).
//
//  A mismatch on either branch returns 404, not 403 — per STEERING's
//  cross-tenant rule, confirming a vendor space exists in another
//  tenant (or isn't yours) is itself a leak.
//
//  Usage:
//  router.put('/:id', authenticate, requireVendorSpaceOwner('id'), controller)
// ─────────────────────────────────────────
export const requireVendorSpaceOwner = (paramName) => {
    return async (req, res, next) => {
        if (!req.user) {
            res.status(401).json({
                status: 'error',
                message: 'Not authenticated',
            });
            return;
        }
        const userRole = req.user.role;
        if (userRole === PlatformRole.SUPER_ADMIN) {
            next();
            return;
        }
        const vendorSpaceId = req.params[paramName];
        if (!vendorSpaceId) {
            res.status(400).json({
                status: 'error',
                message: `Missing route parameter '${paramName}'`,
            });
            return;
        }
        if (userRole === PlatformRole.EVENT_VENDOR) {
            // Single query: membership AND active-space check together, via
            // the join table — not req.user (nothing vendor-space-related is
            // cached there anymore; see auth.middleware.ts's comment on why).
            const membership = await prisma.vendorSpaceUser.findFirst({
                where: { vendorSpaceId, userId: req.user.id, vendorSpace: { isArchived: false } },
                select: { id: true },
            });
            if (membership) {
                next();
                return;
            }
            res.status(404).json({ status: 'error', message: 'Vendor space not found' });
            return;
        }
        if (userRole === PlatformRole.TENANT_ADMIN) {
            const space = await prisma.vendorSpace.findFirst({
                where: { id: vendorSpaceId, isArchived: false, tenantId: req.user.tenantId },
                select: { id: true },
            });
            if (space) {
                next();
                return;
            }
            res.status(404).json({ status: 'error', message: 'Vendor space not found' });
            return;
        }
        res.status(403).json({
            status: 'error',
            message: 'You do not have permission to access this resource',
        });
    };
};
//# sourceMappingURL=role.middleware.js.map