import { Router, type Request, type Response, type NextFunction } from 'express';
import { ticketPurchaseService } from './ticket-purchase.service.js';
import { eventService } from '../event/event.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();
router.use(authenticate, requireEventAdmin);

// Read-only — purchases are created internally by the RSVP-submit
// transaction (POST /api/rsvp/submit), never through a public POST here.
// This prevents overselling a ticket's totalQuantity outside that
// capacity-checked flow.

// GET /api/ticket-purchases/event/:eventId
// Organiser-facing "what was sold" for a whole event — every status
// (PENDING/PAID/FAILED/EXPIRED) included deliberately. Explicitly
// needed so an organiser can still see this after the event is
// cancelled, when nothing about a completed sale can be undone —
// visibility is the only thing left to guarantee (Ticketing & Payments
// batch). TicketPurchase has no tenantId of its own — ownership is
// transitive through its parent Event, so this gates on
// eventService.getById, same pattern as every other event-child
// resource (event-day.router.ts, guest-event.router.ts): it throws
// HttpError(404) for a cross-tenant eventId, indistinguishable from the
// event not existing.
router.get('/event/:eventId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await eventService.getById(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    const purchases = await ticketPurchaseService.getAllForEvent(req.params['eventId'] as string);
    res.status(200).json({ status: 'ok', data: purchases });
  } catch (err) { next(err); }
});

router.get('/invite/:inviteId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const purchases = await ticketPurchaseService.getAll(req.params['inviteId'] as string);
    res.status(200).json({ status: 'ok', data: purchases });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const purchase = await ticketPurchaseService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: purchase });
  } catch (err) { next(err); }
});

export default router;
