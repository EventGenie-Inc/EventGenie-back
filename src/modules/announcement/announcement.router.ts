import { Router, type Request, type Response, type NextFunction } from 'express';
import { announcementService } from './announcement.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId from the parent mount path. Every
// route belongs to `announcements`: off, they are a 404 like a missing
// route. (The cancellation email is sent by POST /api/events/:id/cancel,
// event.router.ts, which is not part of the feature.)
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('announcements'), requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const announcements = await announcementService.list(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: announcements });
  } catch (err) { next(err); }
});

router.post('/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const preview = await announcementService.preview(req.params['eventId'] as string, auth.user.role, auth.user.tenantId, req.body ?? {});
    res.status(200).json({ status: 'ok', data: preview });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await announcementService.send(
      req.params['eventId'] as string,
      auth.user.id,
      auth.user.role,
      auth.user.tenantId,
      req.body ?? {}
    );
    res.status(201).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
