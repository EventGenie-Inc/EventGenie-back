import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { ticketSalesService } from './ticket-sales.service.js';
import { ticketSalesOrdersService } from './ticket-sales-orders.service.js';

// /api/events/:eventId/ticket-sales — the paid switch (ticket-sales.service.ts).
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('ticketing'), requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await ticketSalesService.get(req.params['eventId'] as string, auth.user.role, auth.user.tenantId) });
  } catch (err) { next(err); }
});

router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const data = await ticketSalesService.update(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data });
  } catch (err) { next(err); }
});

// The sales view (ticket sales Round B): totals per type, and the orders
// with their buyers (the event's admins only).
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await ticketSalesOrdersService.summary(req.params['eventId'] as string, auth.user.role, auth.user.tenantId) });
  } catch (err) { next(err); }
});

router.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.set('Cache-Control', 'no-store');
    const data = await ticketSalesOrdersService.orders(req.params['eventId'] as string, auth.user.role, auth.user.tenantId, req.query as Record<string, unknown>);
    res.status(200).json({ status: 'ok', data });
  } catch (err) { next(err); }
});

// Cancel tickets: { reason, ticketIds? }. No money moves.
router.post('/orders/:orderId/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const data = await ticketSalesOrdersService.cancel(
      req.params['eventId'] as string, req.params['orderId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body
    );
    res.status(200).json({ status: 'ok', data });
  } catch (err) { next(err); }
});

export default router;
