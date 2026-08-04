import { Router, type Request, type Response, type NextFunction } from 'express';
import { ticketService } from './ticket.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId from parent router
const router = Router({ mergeParams: true });

// Public reads — guests browsing an event need to see purchasable tickets
// with no auth. No router.use(authenticate, ...) at the top of this file.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tickets = await ticketService.getAllPublic(req.params['eventId'] as string);
    res.status(200).json({ status: 'ok', data: tickets });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ticket = await ticketService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: ticket });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const ticket = await ticketService.create(req.params['eventId'] as string, auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: ticket });
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const ticket = await ticketService.update(req.params['id'] as string, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: ticket });
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await ticketService.archive(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Ticket archived' });
  } catch (err) { next(err); }
});

export default router;
