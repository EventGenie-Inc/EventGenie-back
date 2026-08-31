import { Router } from 'express';
import { vendorService } from './vendor.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdminOrVendor, requireTenantAdmin, requireVendorSpaceOwner, } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
import { HttpError } from '../../shared/errors/http-error.js';
const router = Router();
// ─────────────────────────────────────────
//  VENDOR SPACE
//  Base: /api/vendors
// ─────────────────────────────────────────
// GET /api/vendors?includeArchived=true
// SUPER_ADMIN sees all, others see their own tenant's vendors —
// includeArchived lets a tenant admin see (and then restore) their own
// archived spaces, same pattern as guest-event.router.ts's list route.
router.get('/', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const includeArchived = req.query['includeArchived'] === 'true';
        const spaces = await vendorService.getAllSpaces(auth.user.role, auth.user.tenantId, includeArchived);
        res.status(200).json({ status: 'ok', data: spaces });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/vendors/nearby?latitude=xx&longitude=xx&radius=xx
// GET /api/vendors/nearby?eventId=xx&radius=xx
//
// DISCOVERY — deliberately cross-tenant (see vendor.service.ts). Two
// ways to search: raw coordinates, or an eventId (resolved through the
// normal tenant-scoped event lookup, then searched cross-tenant from
// its coordinates — see getNearbyVendorsForEvent's own comment).
router.get('/nearby', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const eventId = req.query['eventId'];
        const radius = req.query['radius'] ? parseFloat(req.query['radius']) : undefined;
        if (eventId) {
            const vendors = await vendorService.getNearbyVendorsForEvent(eventId, auth.user.role, auth.user.tenantId, radius);
            res.status(200).json({ status: 'ok', data: vendors });
            return;
        }
        const latitude = parseFloat(req.query['latitude']);
        const longitude = parseFloat(req.query['longitude']);
        if (isNaN(latitude) || isNaN(longitude)) {
            res.status(400).json({ status: 'error', message: 'Provide either eventId, or both latitude and longitude, as query params' });
            return;
        }
        const vendors = await vendorService.findNearbyVendors(latitude, longitude, auth.user.tenantId, radius);
        res.status(200).json({ status: 'ok', data: vendors });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/vendors/browse
//
// General browse — the third discovery surface, alongside /nearby and
// the event-scoped variant. Cross-tenant, no location filter. Must be
// registered before /:id or Express would match "browse" as an :id
// value (same reason /nearby and /mine are registered up here too).
router.get('/browse', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const vendors = await vendorService.getBrowseVendors(auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: vendors });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/vendors/mine
//
// Self-service: a vendor user may now belong to several spaces
// (Vendor Space Follow-up, Task 1) — this is how the frontend gets the
// list to show a chooser. Any authenticated user may call it; a
// non-vendor role simply gets an empty list (they hold no memberships).
router.get('/mine', authenticate, async (req, res, next) => {
    try {
        const auth = req;
        const spaces = await vendorService.getMySpaces(auth.user.id);
        res.status(200).json({ status: 'ok', data: spaces });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/vendors/:id
router.get('/:id', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const space = await vendorService.getSpaceById(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: space });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/vendors
// Vendors don't self-onboard a new space — they're assigned to an existing
// one via POST /:vendorSpaceId/assign-user below.
router.post('/', authenticate, requireTenantAdmin, async (req, res, next) => {
    try {
        const auth = req;
        const space = await vendorService.createSpace(auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: space });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/vendors/:id
router.put('/:id', authenticate, requireVendorSpaceOwner('id'), async (req, res, next) => {
    try {
        const auth = req;
        const space = await vendorService.updateSpace(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: space });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/vendors/:id
router.delete('/:id', authenticate, requireVendorSpaceOwner('id'), async (req, res, next) => {
    try {
        const auth = req;
        await vendorService.archiveSpace(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'Vendor space archived' });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/vendors/:id/reactivate
//
// Self-service restore (TENANT_ADMIN of the owning tenant, or
// SUPER_ADMIN) — NOT gated by requireVendorSpaceOwner, because that
// middleware's own lookup filters isArchived:false and would 404 an
// archived space before this route ever ran. requireTenantAdmin is a
// role-shape check only; the real tenant-ownership check happens inside
// vendorService.reactivateSpace via its own includeArchived lookup.
router.post('/:id/reactivate', authenticate, requireTenantAdmin, async (req, res, next) => {
    try {
        const auth = req;
        const space = await vendorService.reactivateSpace(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: space });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/vendors/:vendorSpaceId/users
// Links an existing platform User (role EVENT_VENDOR) to this vendor
// space — many-to-many now (Vendor Space Follow-up, Task 1): a user may
// already manage other spaces, and a space may already have other
// users. Replaces the old single POST /:vendorSpaceId/assign-user
// (there was no real consumer yet, so no back-compat route is kept).
router.post('/:vendorSpaceId/users', authenticate, requireTenantAdmin, async (req, res, next) => {
    try {
        const auth = req;
        if (!req.body.userId)
            throw new HttpError(400, 'userId is required');
        const membership = await vendorService.assignVendorUser(req.params['vendorSpaceId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body.userId);
        res.status(201).json({ status: 'ok', data: membership });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/vendors/:vendorSpaceId/users/:userId
// Removes a user's membership on this vendor space. Hard-deletes the
// join row (see schema comment on VendorSpaceUser) — this is a
// membership fact, not a soft-deletable business entity.
router.delete('/:vendorSpaceId/users/:userId', authenticate, requireTenantAdmin, async (req, res, next) => {
    try {
        const auth = req;
        await vendorService.unassignVendorUser(req.params['vendorSpaceId'], auth.user.role, auth.user.tenantId, req.params['userId']);
        res.status(200).json({ status: 'ok', message: 'User unassigned from vendor space' });
    }
    catch (err) {
        next(err);
    }
});
// ─────────────────────────────────────────
//  VENDOR SERVICES
//  Base: /api/vendors/:vendorSpaceId/services
// ─────────────────────────────────────────
// GET /api/vendors/:vendorSpaceId/services?includeArchived=true
router.get('/:vendorSpaceId/services', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const includeArchived = req.query['includeArchived'] === 'true';
        const services = await vendorService.getAllServices(req.params['vendorSpaceId'], auth.user.role, auth.user.tenantId, includeArchived);
        res.status(200).json({ status: 'ok', data: services });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/vendors/:vendorSpaceId/services/:id
router.get('/:vendorSpaceId/services/:id', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const service = await vendorService.getServiceById(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: service });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/vendors/:vendorSpaceId/services
router.post('/:vendorSpaceId/services', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        const service = await vendorService.createService(req.params['vendorSpaceId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: service });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/vendors/:vendorSpaceId/services/:id
router.put('/:vendorSpaceId/services/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        const service = await vendorService.updateService(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: service });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/vendors/:vendorSpaceId/services/:id
router.delete('/:vendorSpaceId/services/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        await vendorService.archiveService(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'Vendor service archived' });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/vendors/:vendorSpaceId/services/:id/reactivate
//
// Gated by requireVendorSpaceOwner (not requireTenantAdmin): the PARENT
// space must be active for a child service restore to succeed (see
// vendor.service.ts's getServiceById), and that's exactly what this
// middleware already checks — it looks at the SPACE's archived state,
// not the service's, so an archived service under an active space
// still passes it correctly.
router.post('/:vendorSpaceId/services/:id/reactivate', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        const service = await vendorService.reactivateService(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: service });
    }
    catch (err) {
        next(err);
    }
});
// ─────────────────────────────────────────
//  PRODUCTS
//  Base: /api/vendors/:vendorSpaceId/services/:serviceId/products
// ─────────────────────────────────────────
// GET /api/vendors/:vendorSpaceId/services/:serviceId/products?includeArchived=true
router.get('/:vendorSpaceId/services/:serviceId/products', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const includeArchived = req.query['includeArchived'] === 'true';
        const products = await vendorService.getAllProducts(req.params['serviceId'], auth.user.role, auth.user.tenantId, includeArchived);
        res.status(200).json({ status: 'ok', data: products });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/vendors/:vendorSpaceId/services/:serviceId/products/:id
router.get('/:vendorSpaceId/services/:serviceId/products/:id', authenticate, requireEventAdminOrVendor, async (req, res, next) => {
    try {
        const auth = req;
        const product = await vendorService.getProductById(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: product });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/vendors/:vendorSpaceId/services/:serviceId/products
router.post('/:vendorSpaceId/services/:serviceId/products', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        const product = await vendorService.createProduct(req.params['serviceId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: product });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/vendors/:vendorSpaceId/services/:serviceId/products/:id
router.put('/:vendorSpaceId/services/:serviceId/products/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        const product = await vendorService.updateProduct(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: product });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/vendors/:vendorSpaceId/services/:serviceId/products/:id
router.delete('/:vendorSpaceId/services/:serviceId/products/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        await vendorService.archiveProduct(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'Product archived' });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/vendors/:vendorSpaceId/services/:serviceId/products/:id/reactivate
router.post('/:vendorSpaceId/services/:serviceId/products/:id/reactivate', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req, res, next) => {
    try {
        const auth = req;
        const product = await vendorService.reactivateProduct(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: product });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=vendor.router.js.map