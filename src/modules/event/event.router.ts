import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventService } from './event.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();
router.use(authenticate, requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const events = await eventService.getAll(auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: events });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await eventService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenantId = auth.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const event = await eventService.create(tenantId, auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const event = await eventService.update(req.params['id'] as string, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await eventService.archive(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Event archived' });
  } catch (err) { next(err); }
});

export default router;