import { Router, type Request, type Response, type NextFunction } from 'express';
import { ticketService } from './ticket.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId from parent router.
//
// Organiser-only, every route — including the reads, which used to be
// public. No guest path reads tickets here (see ticket.service.ts): guests
// get theirs through their invite token on /api/rsvp.
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('ticketing'), requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tickets = await ticketService.getAllForAdmin(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: tickets });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const ticket = await ticketService.getById(req.params['id'] as string, req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: ticket });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const ticket = await ticketService.create(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(201).json({ status: 'ok', data: ticket });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const ticket = await ticketService.update(
      req.params['id'] as string, req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body
    );
    res.status(200).json({ status: 'ok', data: ticket });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await ticketService.archive(req.params['id'] as string, req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', message: 'Ticket archived' });
  } catch (err) { next(err); }
});

export default router;
