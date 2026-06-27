import { Router, type Response, type NextFunction } from 'express';
import { eventDayService } from './event-day.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams lets us access :eventId from the parent router
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const days = await eventDayService.getAll(req.params.eventId!);
    res.status(200).json({ status: 'ok', data: days });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const day = await eventDayService.getById(req.params.id!);
    res.status(200).json({ status: 'ok', data: day });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const day = await eventDayService.create(req.params.eventId!, req.user.id, req.body);
    res.status(201).json({ status: 'ok', data: day });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const day = await eventDayService.update(req.params.id!, req.user.id, req.body);
    res.status(200).json({ status: 'ok', data: day });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await eventDayService.archive(req.params.id!, req.user.id);
    res.status(200).json({ status: 'ok', message: 'Event day archived' });
  } catch (err) { next(err); }
});

export default router;