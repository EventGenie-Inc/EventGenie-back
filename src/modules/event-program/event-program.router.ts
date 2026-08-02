import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventProgramService } from './event-program.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId from parent router
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const program = await eventProgramService.getByEventId(req.params['eventId'] as string);
    res.status(200).json({ status: 'ok', data: program });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const program = await eventProgramService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: program });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const program = await eventProgramService.create(req.params['eventId'] as string, auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: program });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const program = await eventProgramService.update(req.params['id'] as string, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: program });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await eventProgramService.archive(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Program archived' });
  } catch (err) { next(err); }
});

export default router;
