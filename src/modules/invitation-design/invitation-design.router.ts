import { Router, type Request, type Response, type NextFunction } from 'express';
import { invitationDesignService } from './invitation-design.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { uploadSignatureLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// Mounted at /api/events/:eventId/invitation-design
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('invitationDesigns'), requireEventAdmin);

// GET — the event's active design, or data: null
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const design = await invitationDesignService.getForEvent(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: design });
  } catch (err) { next(err); }
});

// PUT — create or replace (TEMPLATE or UPLOAD)
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const design = await invitationDesignService.put(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data: design });
  } catch (err) { next(err); }
});

// POST — signed Cloudinary upload for the organiser's own design image
router.post('/upload-signature', uploadSignatureLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await invitationDesignService.requestUploadSignature(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
