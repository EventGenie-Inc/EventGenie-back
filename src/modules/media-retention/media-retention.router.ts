import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { mediaRetentionService } from './media-retention.service.js';

const router = Router();

// Platform operations: SUPER_ADMIN only, and the global 404 for everyone
// else (like system health), so the route's existence isn't confirmed.
router.use(authenticate, requireSuperAdminHidden);

// POST /api/admin/events/:eventId/media-purge
// Deletes an archived event's Memory Hub photos and videos now, the way the
// retention sweep does 30 days after archiving (media-retention.service.ts),
// recorded with who asked and when. 409 EVENT_NOT_ARCHIVED for a live
// event, 409 MEDIA_PURGE_ALREADY_STARTED once a purge has begun.
router.post('/:eventId/media-purge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const purge = await mediaRetentionService.purgeNowAsSuperAdmin(req.params['eventId'] as string, auth.user.id, auth.user.role);
    res.status(200).json({ status: 'ok', data: purge });
  } catch (err) { next(err); }
});

export default router;
