import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventPassService } from './event-pass.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin, requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// Nested under /api/events/:eventId/pass (app.ts) — mergeParams is set
// there, same as every other event-child router (event-day, guest,
// invite, ticket).
const router = Router({ mergeParams: true });

router.use(authenticate);

// GET routes — any EVENT_ADMIN+ of the owning tenant can view pass/
// bundle status, same access level as every other event-scoped read
// (event.router.ts's GET /:id, etc).
router.get('/', requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const eventId = req.params['eventId'] as string;
    const status = await eventPassService.getForEvent(eventId, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: status });
  } catch (err) { next(err); }
});

router.get('/sms-bundle', requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const eventId = req.params['eventId'] as string;
    const status = await eventPassService.getSmsBundleForEvent(eventId, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: status });
  } catch (err) { next(err); }
});

// Purchase / reconcile routes — money-moving, gated requireTenantAdmin,
// same convention as subscription.router.ts / payment-account.router.ts.
router.post('/purchase', requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const eventId = req.params['eventId'] as string;
    const callbackUrl = `${process.env.FRONTEND_BASE_URL}/billing/event-pass/callback`;
    const result = await eventPassService.purchasePass(eventId, auth.user.role, auth.user.tenantId, req.body, callbackUrl);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/purchases/:purchaseId/reconcile', requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await eventPassService.reconcilePassPurchase(req.params['purchaseId'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/sms-bundle/purchase', requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const eventId = req.params['eventId'] as string;
    const callbackUrl = `${process.env.FRONTEND_BASE_URL}/billing/event-pass/sms-bundle/callback`;
    const result = await eventPassService.purchaseSmsBundle(eventId, auth.user.role, auth.user.tenantId, req.body, callbackUrl);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/sms-bundle/purchases/:purchaseId/reconcile', requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await eventPassService.reconcileSmsBundlePurchase(req.params['purchaseId'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
