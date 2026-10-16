import { Router, type Request, type Response, type NextFunction } from 'express';
import { feedbackService } from './feedback.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { uploadSignatureLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId from the parent mount path. Every
// route belongs to `feedback`: off, they are a 404 like a missing route.
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('feedback'), requireEventAdmin);

// GET /api/events/:eventId/feedback
// The feedback (or null), each permission's current state, the eligible
// photos and the selection, and the wording of every tick.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await feedbackService.getForOrganiser(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// PUT /api/events/:eventId/feedback
// { score?, workedBest?, toImprove?, permissions?, selectedPhotoIds?, logo? }
// Creates or edits; a field left out is left as it is (score is required
// the first time). Answers with the same body as GET.
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await feedbackService.save(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body ?? {});
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/feedback/logo-signature
// A signed upload into the tenant's own logo folder.
router.post('/logo-signature', uploadSignatureLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await feedbackService.requestLogoSignature(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
