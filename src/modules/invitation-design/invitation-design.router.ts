import { Router, type Request, type Response, type NextFunction } from 'express';
import { invitationDesignService } from './invitation-design.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { designUploadSignatureLimiter, starterCopyLimiter, uploadSignatureLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// Mounted at /api/events/:eventId/invitation-design
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('invitationDesigns'), requireEventAdmin);

// GET — the event's active design (with editable / notEditableReason), or data: null
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const design = await invitationDesignService.getForEvent(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: design });
  } catch (err) { next(err); }
});

// PUT — create or replace (TEMPLATE, UPLOAD or CANVAS)
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const design = await invitationDesignService.put(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data: design });
  } catch (err) { next(err); }
});

// DELETE — reset to default: the design is archived (any plan)
router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const design = await invitationDesignService.reset(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: design });
  } catch (err) { next(err); }
});

// POST — signed Cloudinary upload for the organiser's own design image (UPLOAD)
router.post('/upload-signature', uploadSignatureLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await invitationDesignService.requestUploadSignature(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST — signed Cloudinary upload for a CANVAS design: { purpose: 'ASSET' | 'RENDER' }
router.post('/canvas-upload-signature', designUploadSignatureLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await invitationDesignService.requestCanvasUploadSignature(
      req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body
    );
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST — start from a starter design: { starterId } → the organiser's own copy
// to edit (its images copied into this event's files). Saves nothing.
router.post('/from-starter', starterCopyLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await invitationDesignService.startFromStarter(
      req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body
    );
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
