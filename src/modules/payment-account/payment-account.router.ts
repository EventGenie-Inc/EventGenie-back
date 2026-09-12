import { Router, type Request, type Response, type NextFunction } from 'express';
import { paymentAccountService } from './payment-account.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

router.use(authenticate, requireTenantAdmin);

// Every route below operates on the CALLER's own tenant (from the JWT),
// never a route param — same self-service shape as tenant.router.ts's
// GET /me. A SUPER_ADMIN technically passes requireTenantAdmin but has
// no tenant of their own, so this guard catches that the same way
// event.router.ts's create-event route does.
const requireOwnTenantId = (req: Request, res: Response): string | undefined => {
  const auth = req as AuthenticatedRequest;
  if (!auth.user.tenantId) {
    res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
    return undefined;
  }
  return auth.user.tenantId;
};

// GET /api/payments/subaccount/banks — reference data for the
// onboarding form's bank picker. Registered before '/' so it isn't
// swallowed by a param route (there is none here, but matches the
// specific-before-generic convention used across the other routers).
router.get('/banks', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const banks = await paymentAccountService.listBanks();
    res.status(200).json({ status: 'ok', data: banks });
  } catch (err) { next(err); }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const status = await paymentAccountService.getStatus(tenantId);
    res.status(200).json({ status: 'ok', data: status });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const tenant = await paymentAccountService.submit(tenantId, req.body);
    res.status(201).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const tenant = await paymentAccountService.update(tenantId, req.body);
    res.status(200).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

export default router;
