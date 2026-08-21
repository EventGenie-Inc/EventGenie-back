import { Router, type Request, type Response, type NextFunction } from 'express';
import { tenantService } from './tenant.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

// Self-service lookup of the caller's own tenant — must be registered before
// the blanket SUPER_ADMIN guard below, since any authenticated user needs it.
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    if (!auth.user.tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const tenant = await tenantService.getById(auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

// All other tenant routes are SUPER_ADMIN only
router.use(authenticate, requireSuperAdmin);

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tenants = await tenantService.getAll();
    res.status(200).json({ status: 'ok', data: tenants });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = await tenantService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

router.get('/:id/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await tenantService.getUsers(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: users });
  } catch (err) { next(err); }
});

router.post('/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenant = await tenantService.suspend(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

router.post('/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenant = await tenantService.reactivate(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

export default router;
