import { Router, type Request, type Response, type NextFunction } from 'express';
import { userService } from './user.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin, requireSuperAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();
router.use(authenticate, requireTenantAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const users = await userService.getAll(auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: users });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userService.create(req.body);
    res.status(201).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userService.update(req.params['id'] as string, req.body);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await userService.archive(req.params['id'] as string);
    res.status(200).json({ status: 'ok', message: 'User archived' });
  } catch (err) { next(err); }
});

// Super Admin only — individual user suspend/reactivate,
// stacked on top of the router-level requireTenantAdmin
router.post('/:id/suspend', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userService.archive(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

router.post('/:id/reactivate', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userService.reactivate(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

export default router;