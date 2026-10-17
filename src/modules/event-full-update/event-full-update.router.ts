import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventFullUpdateService } from './event-full-update.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// PUT /api/events/:eventId/full — the whole edited event, all or nothing
// (event-full-update.service.ts). The per-part endpoints stay for the
// other screens that use them.
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const event = await eventFullUpdateService.update(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

export default router;
