import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventPublicService } from './event-public.service.js';
import {
  publicEventViewLimiter,
  publicRegistrationIpLimiter,
  publicRegistrationEventLimiter,
} from '../../shared/middleware/rate-limit.middleware.js';

// Fully public surface — a registrant holds nothing but the event's
// shareToken, never a platform session. No `authenticate` anywhere in
// this file, mirroring memory-hub-public.router.ts / rsvp.router.ts.
const router = Router();

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
// { firstName, surname?, email?, phoneNumber? } — creates a Guest +
// Invite and returns the invite's token, which the frontend uses to
// redirect the registrant into the existing /rsvp?token=... flow.
// Two rate limiters stacked (per IP, per event) — see
// rate-limit.middleware.ts's comment for why both are needed.
router.post(
  '/:shareToken/register',
  publicRegistrationIpLimiter,
  publicRegistrationEventLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await eventPublicService.register(req.params['shareToken'] as string, req.body);
      res.status(result.isExistingRegistration ? 200 : 201).json({ status: 'ok', data: result });
    } catch (err) { next(err); }
  }
);

export default router;
