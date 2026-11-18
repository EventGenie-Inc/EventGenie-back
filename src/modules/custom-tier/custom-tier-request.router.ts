import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { requireSuperAdminHidden, requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { customTierRequestService } from './custom-tier-request.service.js';

// ─────────────────────────────────────────
//  REQUESTS FOR A CUSTOM TIER (behind customTiers)
//  /api/custom-tier-requests              POST (tenant admin) ask; GET their own
//  /api/admin/custom-tier-requests        GET (super admin) every request, ?status=
//  /api/admin/custom-tier-requests/:id    PATCH (super admin) { status?, note? }
// ─────────────────────────────────────────

export const customTierRequestRouter = Router();
customTierRequestRouter.use(authenticate, requireFeature('customTiers'), requireTenantAdmin);

const ownTenantId = (req: Request, res: Response): string | null => {
  const auth = req as AuthenticatedRequest;
  if (!auth.user.tenantId) {
    res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
    return null;
  }
  return auth.user.tenantId;
};

customTierRequestRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = ownTenantId(req, res);
    if (!tenantId) return;
    const auth = req as AuthenticatedRequest;
    res.status(201).json({ status: 'ok', data: await customTierRequestService.create(tenantId, auth.user.id, req.body) });
  } catch (err) { next(err); }
});

customTierRequestRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = ownTenantId(req, res);
    if (!tenantId) return;
    res.status(200).json({ status: 'ok', data: await customTierRequestService.listForTenant(tenantId) });
  } catch (err) { next(err); }
});

export const adminCustomTierRequestRouter = Router();
adminCustomTierRequestRouter.use(authenticate, requireFeature('customTiers'), requireSuperAdminHidden);

adminCustomTierRequestRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await customTierRequestService.list(req.query['status']) });
  } catch (err) { next(err); }
});

adminCustomTierRequestRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await customTierRequestService.update(req.params['id'] as string, req.body, auth.user.id) });
  } catch (err) { next(err); }
});
