import { Router, type Request, type Response, type NextFunction } from 'express';
import { guestService } from './guest.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';

const router = Router();
router.use(authenticate, requireEventAdmin);

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const guests = await guestService.getAll();
    res.status(200).json({ status: 'ok', data: guests });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const guest = await guestService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: guest });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const guest = await guestService.create(req.body);
    res.status(201).json({ status: 'ok', data: guest });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const guest = await guestService.update(req.params['id'] as string, req.body);
    res.status(200).json({ status: 'ok', data: guest });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await guestService.archive(req.params['id'] as string);
    res.status(200).json({ status: 'ok', message: 'Guest archived' });
  } catch (err) { next(err); }
});

export default router;