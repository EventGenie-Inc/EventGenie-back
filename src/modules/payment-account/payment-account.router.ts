import { Router, type Request, type Response, type NextFunction } from 'express';
import { paymentAccountService } from './payment-account.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { payoutCancelLinkLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { NO_ORGANISATION_MESSAGE } from '../../shared/payments/payment-errors.util.js';

// /api/payments/subaccount — the organisation's payout account (STEERING
// "Ticket sales"). Behind `ticketing`.
const router = Router();

// The emailed cancel link: no sign-in, the token in the body (never in a
// path or query string). Registered before the sign-in middleware below.
router.post(
  '/change/cancel-by-link',
  requireFeature('ticketing'),
  payoutCancelLinkLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      const result = await paymentAccountService.cancelByLink((req.body as { token?: unknown } | undefined)?.token);
      res.status(200).json({ status: 'ok', data: result });
    } catch (err) { next(err); }
  }
);

// Everything else: Tenant Admins only, on their own organisation (from the
// session, never a route param). A SUPER_ADMIN passes requireTenantAdmin
// but has no organisation of its own, so it is refused below.
router.use(authenticate, requireFeature('ticketing'), requireTenantAdmin);

const requireOwnTenantId = (req: Request, res: Response): string | undefined => {
  const auth = req as AuthenticatedRequest;
  if (!auth.user.tenantId) {
    res.status(400).json({ status: 'error', message: NO_ORGANISATION_MESSAGE });
    return undefined;
  }
  return auth.user.tenantId;
};

// The bank list for the form: Paystack's South African banks, cached.
router.get('/banks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await paymentAccountService.listBanks() });
  } catch (err) { next(err); }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    res.status(200).json({ status: 'ok', data: await paymentAccountService.getStatus(tenantId) });
  } catch (err) { next(err); }
});

// The first setup: 201 once Paystack confirms it, 202 while its answer is
// still being confirmed.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const { dto, confirmed } = await paymentAccountService.setUp(tenantId, (req as AuthenticatedRequest).user.id, req.body);
    res.status(confirmed ? 201 : 202).json({ status: 'ok', data: dto });
  } catch (err) { next(err); }
});

// A change: waits 24 hours. 200 once Paystack confirms the new account, 202
// while that is still being confirmed.
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const { dto, confirmed } = await paymentAccountService.requestChange(tenantId, (req as AuthenticatedRequest).user.id, req.body);
    res.status(confirmed ? 200 : 202).json({ status: 'ok', data: dto });
  } catch (err) { next(err); }
});

// Cancel the waiting change from the app.
router.post('/change/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    res.status(200).json({ status: 'ok', data: await paymentAccountService.cancelFromApp(tenantId, (req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

export default router;
