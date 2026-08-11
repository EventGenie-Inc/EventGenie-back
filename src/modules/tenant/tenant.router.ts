import { Router, type Request, type Response, type NextFunction } from 'express';
import { tenantService } from './tenant.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdmin } from '../../shared/middleware/role.middleware.js';

const router = Router();

// All tenant routes are SUPER_ADMIN only
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

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = await tenantService.create(req.body);
    res.status(201).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = await tenantService.update(req.params['id'] as string, req.body);
    res.status(200).json({ status: 'ok', data: tenant });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await tenantService.archive(req.params['id'] as string);
    res.status(200).json({ status: 'ok', message: 'Tenant archived' });
  } catch (err) { next(err); }
});

export default router;