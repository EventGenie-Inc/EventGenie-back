import { Router, type Request, type Response, type NextFunction } from 'express';
import { subscriptionService } from './subscription.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

router.use(authenticate, requireTenantAdmin);

// Every route below operates on the CALLER's own tenant (from the JWT),
// never a route param — same self-service shape as payment-account.router.ts.
const requireOwnTenantId = (req: Request, res: Response): string | undefined => {
  const auth = req as AuthenticatedRequest;
  if (!auth.user.tenantId) {
    res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
    return undefined;
  }
  return auth.user.tenantId;
};

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const status = await subscriptionService.getStatus(tenantId);
    res.status(200).json({ status: 'ok', data: status });
  } catch (err) { next(err); }
});

router.post('/subscribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const callbackUrl = `${process.env.FRONTEND_BASE_URL}/billing/callback`;
    const result = await subscriptionService.subscribe(tenantId, req.body, callbackUrl);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.put('/change-tier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const result = await subscriptionService.changeTier(tenantId, req.body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const result = await subscriptionService.cancel(tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
