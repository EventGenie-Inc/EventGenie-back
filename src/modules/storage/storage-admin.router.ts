import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { storageReconciliationService } from './storage-reconciliation.service.js';

const router = Router();

// Platform operations: SUPER_ADMIN only, the global 404 for everyone else.
router.use(authenticate, requireSuperAdminHidden);

// GET /api/admin/storage/reconciliations — the 20 latest runs, newest
// first, totals only.
router.get('/reconciliations', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await storageReconciliationService.list() });
  } catch (err) { next(err); }
});

// GET /api/admin/storage/reconciliations/:id — one run with its details.
router.get('/reconciliations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await storageReconciliationService.get(req.params['id'] as string) });
  } catch (err) { next(err); }
});

// POST /api/admin/storage/reconciliations — run one now. A report only:
// nothing is deleted.
router.post('/reconciliations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await storageReconciliationService.runNow(auth.user.id) });
  } catch (err) { next(err); }
});

export default router;
