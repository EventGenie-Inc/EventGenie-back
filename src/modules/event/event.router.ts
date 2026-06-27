import { Router, type Response, type NextFunction } from 'express';
import { eventService } from './event.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

router.use(authenticate, requireEventAdmin);

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const events = await eventService.getAll(req.user.role, req.user.tenantId);
    res.status(200).json({ status: 'ok', data: events });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const event = await eventService.getById(req.params.id!);
    res.status(200).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const event = await eventService.create(tenantId, req.user.id, req.body);
    res.status(201).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const event = await eventService.update(req.params.id!, req.user.id, req.body);
    res.status(200).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await eventService.archive(req.params.id!, req.user.id);
    res.status(200).json({ status: 'ok', message: 'Event archived' });
  } catch (err) { next(err); }
});

export default router;