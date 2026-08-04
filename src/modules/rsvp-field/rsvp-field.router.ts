import { Router, type Request, type Response, type NextFunction } from 'express';
import { rsvpFieldService } from './rsvp-field.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fields = await rsvpFieldService.getAll(req.params['eventId'] as string);
    res.status(200).json({ status: 'ok', data: fields });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const field = await rsvpFieldService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: field });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const field = await rsvpFieldService.create(req.params['eventId'] as string, auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: field });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const field = await rsvpFieldService.update(req.params['id'] as string, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: field });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await rsvpFieldService.archive(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'RSVP field archived' });
  } catch (err) { next(err); }
});

export default router;
