import { Router, type Request, type Response, type NextFunction } from 'express';
import { paymentLedgerService } from './payment-ledger.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

router.use(authenticate, requireTenantAdmin);

// Self-service, own-tenant-only read of the subscription Billing History
// screen — same shape as subscription.router.ts's requireOwnTenantId
// (tenantId comes from the JWT, never a route param; no SUPER_ADMIN
// cross-tenant case exists here).
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    if (!auth.user.tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const history = await paymentLedgerService.listBillingHistoryForTenant(auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: history });
  } catch (err) { next(err); }
});

export default router;
