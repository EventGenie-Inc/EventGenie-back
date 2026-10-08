import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { eventPublicService } from './event-public.service.js';
import {
  publicEventViewLimiter,
  publicRegistrationIpLimiter,
  publicRegistrationEmailLimiter,
  publicRegistrationEventLimiter,
} from '../../shared/middleware/rate-limit.middleware.js';

// Fully public surface — a registrant holds nothing but the event's
// shareToken, never a platform session. No `authenticate` anywhere in
// this file, mirroring memory-hub-public.router.ts / rsvp.router.ts.
const router = Router();

// The whole public registration surface belongs to publicEvents.
router.use(requireFeature('publicEvents'));

// GET /api/public-events/:shareToken
// Public event view, resolved from the share token — lets the page show
// what the event is before asking anyone to register.
router.get('/:shareToken', publicEventViewLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await eventPublicService.viewByShareToken(req.params['shareToken'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/public-events/:shareToken/register
// { firstName, surname?, email, phoneNumber?, dayIds?, plusOneNames? } —
// creates the guest and their accepted invite and emails them their
// personal link (never returned here). 201 for a new registration, 200
// when the email was already registered (their link is re-sent).
// Three limiters stacked (per IP, per email, per event) — see
// rate-limit.middleware.ts's comment for why each is needed.
router.post(
  '/:shareToken/register',
  publicRegistrationIpLimiter,
  publicRegistrationEmailLimiter,
  publicRegistrationEventLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await eventPublicService.register(req.params['shareToken'] as string, req.body);
      res.status(result.outcome === 'REGISTERED' ? 201 : 200).json({ status: 'ok', data: result });
    } catch (err) { next(err); }
  }
);

export default router;
