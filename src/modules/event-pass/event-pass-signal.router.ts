import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventPassService } from './event-pass.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// Top-level, tenant-wide (not event-scoped) — mounted at
// /api/event-passes (app.ts). Every route operates on the CALLER's own
// tenant, same self-service shape as subscription.router.ts's
// requireOwnTenantId.
const router = Router();

router.use(authenticate, requireTenantAdmin);

const requireOwnTenantId = (req: Request, res: Response): string | undefined => {
  const auth = req as AuthenticatedRequest;
  if (!auth.user.tenantId) {
    res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
    return undefined;
  }
  return auth.user.tenantId;
};

// "Someone buying a second pass is the strongest subscription prospect
// there is." Backend-only signal — the frontend prompt itself is out of
// scope for this batch.
router.get('/signal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = requireOwnTenantId(req, res);
    if (!tenantId) return;
    const signal = await eventPassService.getTenantPurchaseSignal(tenantId);
    res.status(200).json({ status: 'ok', data: signal });
  } catch (err) { next(err); }
});

export default router;
