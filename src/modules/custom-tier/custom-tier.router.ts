import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { customTierService } from './custom-tier.service.js';

// ─────────────────────────────────────────
//  CUSTOM TIERS (super admin only; anyone else gets the global 404)
//  /api/admin/custom-tiers                     GET  list (with tenantCount), POST create
//  /api/admin/custom-tiers/:id                 GET, PUT (edit; isActive false retires)
//  /api/admin/tenants/:tenantId/custom-tier    PUT  assign { customTierId, endsAt?, confirmSubscriptionCancelled? }
//                                              DELETE  take the tenant off it
// ─────────────────────────────────────────

export const customTierRouter = Router();
customTierRouter.use(authenticate, requireSuperAdminHidden);

customTierRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await customTierService.list() });
  } catch (err) { next(err); }
});

customTierRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(201).json({ status: 'ok', data: await customTierService.create(req.body, auth.user.id) });
  } catch (err) { next(err); }
});

customTierRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await customTierService.get(req.params['id'] as string) });
  } catch (err) { next(err); }
});

customTierRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await customTierService.update(req.params['id'] as string, req.body, auth.user.id) });
  } catch (err) { next(err); }
});

export const tenantCustomTierRouter = Router({ mergeParams: true });
tenantCustomTierRouter.use(authenticate, requireSuperAdminHidden);

tenantCustomTierRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await customTierService.assign(req.params['tenantId'] as string, req.body, auth.user.id) });
  } catch (err) { next(err); }
});

tenantCustomTierRouter.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await customTierService.unassign(req.params['tenantId'] as string, auth.user.id) });
  } catch (err) { next(err); }
});
