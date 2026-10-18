import { Router, type Request, type Response, type NextFunction } from 'express';
import { subscriptionService } from './subscription.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { frontendUrl } from '../../shared/utils/frontend-url.util.js';

const router = Router();

router.use(authenticate);

// Everything that starts or changes a payment is behind `payments` (off for
// the free launch pilot): guarded per route, before the role gate, so a
// switched-off route 404s for every non-SUPER_ADMIN caller. The read-only
// routes (plans, current status) stay up either way.

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

// Registered before '/' — a static path, not a param route, so order
// doesn't strictly matter here, but this matches the specific-before-
// generic convention used across the other routers. Not tenant-scoped
// (see subscriptionService.getPricing's own comment): every tenant
// reads the exact same four prices.
router.get('/plans', requireTenantAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pricing = subscriptionService.getPricing();
    res.status(200).json({ status: 'ok', data: pricing });
  } catch (err) { next(err); }
});

router.get('/', requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const status = await subscriptionService.getStatus(tenantId);
    res.status(200).json({ status: 'ok', data: status });
  } catch (err) { next(err); }
});

router.post('/subscribe', requireFeature('payments'), requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const callbackUrl = frontendUrl('/billing/callback');
    const result = await subscriptionService.subscribe(tenantId, req.body, callbackUrl);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.get('/update-card-link', requireFeature('payments'), requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const result = await subscriptionService.getUpdateCardLink(tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.put('/change-tier', requireFeature('payments'), requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const result = await subscriptionService.changeTier(tenantId, req.body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/cancel', requireFeature('payments'), requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const result = await subscriptionService.cancel(tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
