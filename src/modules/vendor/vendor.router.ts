import { Router, type Request, type Response, type NextFunction } from 'express';
import { vendorService } from './vendor.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import {
  requireEventAdminOrVendor,
  requireTenantAdmin,
  requireVendorSpaceOwner,
} from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

// ─────────────────────────────────────────
//  VENDOR SPACE
//  Base: /api/vendors
// ─────────────────────────────────────────

// GET /api/vendors
// SUPER_ADMIN sees all, others see their tenant's vendors
router.get('/', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const spaces = await vendorService.getAllSpaces(auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: spaces });
  } catch (err) { next(err); }
});

// GET /api/vendors/nearby?latitude=xx&longitude=xx&radius=xx
// Public-ish: finds vendors near a location (used during event creation)
router.get('/nearby', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const latitude = parseFloat(req.query['latitude'] as string);
    const longitude = parseFloat(req.query['longitude'] as string);
    const radius = req.query['radius'] ? parseFloat(req.query['radius'] as string) : undefined;

    if (isNaN(latitude) || isNaN(longitude)) {
      res.status(400).json({ status: 'error', message: 'latitude and longitude are required query params' });
      return;
    }

    const vendors = await vendorService.findNearbyVendors(latitude, longitude, radius);
    res.status(200).json({ status: 'ok', data: vendors });
  } catch (err) { next(err); }
});

// GET /api/vendors/:id
router.get('/:id', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const space = await vendorService.getSpaceById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: space });
  } catch (err) { next(err); }
});

// POST /api/vendors
// Vendors don't self-onboard a new space — they're assigned to an existing
// one via POST /:vendorSpaceId/assign-user below.
router.post('/', authenticate, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const space = await vendorService.createSpace(auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: space });
  } catch (err) { next(err); }
});

// PUT /api/vendors/:id
router.put('/:id', authenticate, requireVendorSpaceOwner('id'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const space = await vendorService.updateSpace(req.params['id'] as string, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: space });
  } catch (err) { next(err); }
});

// DELETE /api/vendors/:id
router.delete('/:id', authenticate, requireVendorSpaceOwner('id'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await vendorService.archiveSpace(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Vendor space archived' });
  } catch (err) { next(err); }
});

// POST /api/vendors/:vendorSpaceId/assign-user
// Links an existing platform User (role EVENT_VENDOR) to this vendor space.
router.post('/:vendorSpaceId/assign-user', authenticate, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await vendorService.assignVendorUser(
      req.params['vendorSpaceId'] as string,
      req.body.userId
    );
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  VENDOR SERVICES
//  Base: /api/vendors/:vendorSpaceId/services
// ─────────────────────────────────────────

// GET /api/vendors/:vendorSpaceId/services
router.get('/:vendorSpaceId/services', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const services = await vendorService.getAllServices(req.params['vendorSpaceId'] as string);
    res.status(200).json({ status: 'ok', data: services });
  } catch (err) { next(err); }
});

// GET /api/vendors/:vendorSpaceId/services/:id
router.get('/:vendorSpaceId/services/:id', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = await vendorService.getServiceById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: service });
  } catch (err) { next(err); }
});

// POST /api/vendors/:vendorSpaceId/services
router.post('/:vendorSpaceId/services', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const service = await vendorService.createService(
      req.params['vendorSpaceId'] as string,
      auth.user.id,
      req.body
    );
    res.status(201).json({ status: 'ok', data: service });
  } catch (err) { next(err); }
});

// PUT /api/vendors/:vendorSpaceId/services/:id
router.put('/:vendorSpaceId/services/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const service = await vendorService.updateService(
      req.params['id'] as string,
      auth.user.id,
      req.body
    );
    res.status(200).json({ status: 'ok', data: service });
  } catch (err) { next(err); }
});

// DELETE /api/vendors/:vendorSpaceId/services/:id
router.delete('/:vendorSpaceId/services/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await vendorService.archiveService(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Vendor service archived' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  PRODUCTS
//  Base: /api/vendors/:vendorSpaceId/services/:serviceId/products
// ─────────────────────────────────────────

// GET /api/vendors/:vendorSpaceId/services/:serviceId/products
router.get('/:vendorSpaceId/services/:serviceId/products', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await vendorService.getAllProducts(req.params['serviceId'] as string);
    res.status(200).json({ status: 'ok', data: products });
  } catch (err) { next(err); }
});

// GET /api/vendors/:vendorSpaceId/services/:serviceId/products/:id
router.get('/:vendorSpaceId/services/:serviceId/products/:id', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await vendorService.getProductById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: product });
  } catch (err) { next(err); }
});

// POST /api/vendors/:vendorSpaceId/services/:serviceId/products
router.post('/:vendorSpaceId/services/:serviceId/products', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const product = await vendorService.createProduct(
      req.params['serviceId'] as string,
      auth.user.id,
      req.body
    );
    res.status(201).json({ status: 'ok', data: product });
  } catch (err) { next(err); }
});

// PUT /api/vendors/:vendorSpaceId/services/:serviceId/products/:id
router.put('/:vendorSpaceId/services/:serviceId/products/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const product = await vendorService.updateProduct(
      req.params['id'] as string,
      auth.user.id,
      req.body
    );
    res.status(200).json({ status: 'ok', data: product });
  } catch (err) { next(err); }
});

// DELETE /api/vendors/:vendorSpaceId/services/:serviceId/products/:id
router.delete('/:vendorSpaceId/services/:serviceId/products/:id', authenticate, requireVendorSpaceOwner('vendorSpaceId'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await vendorService.archiveProduct(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Product archived' });
  } catch (err) { next(err); }
});

export default router;