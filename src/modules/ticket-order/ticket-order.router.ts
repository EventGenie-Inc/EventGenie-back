import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import {
  ticketCheckoutEmailLimiter,
  ticketCheckoutIpLimiter,
  ticketOrderIpLimiter,
  ticketOrderTokenLimiter,
} from '../../shared/middleware/rate-limit.middleware.js';
import { ticketOrderService } from './ticket-order.service.js';

// /api/ticket-orders — public, no sign-in (ticket sales Round B). Behind
// `ticketing`. The order token always travels in the request body, never a
// path or query string; nothing here is cached.
const router = Router();
router.use(requireFeature('ticketing'));
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// POST /api/ticket-orders/checkout
router.post('/checkout', ticketCheckoutIpLimiter, ticketCheckoutEmailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await ticketOrderService.checkout(req.body ?? {});
    res.status(result.reused ? 200 : 201).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/ticket-orders/status { token, refresh? }
router.post('/status', ticketOrderIpLimiter, ticketOrderTokenLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { token?: unknown; refresh?: unknown };
    res.status(200).json({ status: 'ok', data: await ticketOrderService.status(body.token, body.refresh) });
  } catch (err) { next(err); }
});

// POST /api/ticket-orders/retry { token }
router.post('/retry', ticketOrderIpLimiter, ticketOrderTokenLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await ticketOrderService.retry((req.body ?? {}).token);
    res.status(result.reused ? 200 : 201).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
