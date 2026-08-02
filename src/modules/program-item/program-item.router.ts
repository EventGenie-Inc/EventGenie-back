import { Router, type Request, type Response, type NextFunction } from 'express';
import { programItemService } from './program-item.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId and :programId from the parent mount path
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await programItemService.getAll(req.params['programId'] as string);
    res.status(200).json({ status: 'ok', data: items });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await programItemService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await programItemService.create(req.params['programId'] as string, auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await programItemService.update(req.params['id'] as string, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await programItemService.archive(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Program item archived' });
  } catch (err) { next(err); }
});

export default router;
