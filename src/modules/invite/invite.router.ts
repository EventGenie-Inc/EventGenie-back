import { Router, type Request, type Response, type NextFunction } from 'express';
import { inviteService } from './invite.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invites = await inviteService.getAll(req.params['eventId'] as string);
    res.status(200).json({ status: 'ok', data: invites });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invite = await inviteService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: invite });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const invite = await inviteService.create(req.params['eventId'] as string, auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: invite });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const invite = await inviteService.update(req.params['id'] as string, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: invite });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await inviteService.archive(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Invite archived' });
  } catch (err) { next(err); }
});

export default router;