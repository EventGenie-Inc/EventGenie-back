import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { feedbackAdminService } from './feedback-admin.service.js';
import { feedbackCsv } from './feedback-export.util.js';

const router = Router();

// Platform operations: SUPER_ADMIN only, and the global 404 for everyone
// else (like system health). Part of `feedback`, which never hides
// anything from a SUPER_ADMIN; for anyone else the route is a 404 either way.
router.use(authenticate, requireFeature('feedback'), requireSuperAdminHidden);

// GET /api/admin/feedback
// Every event's feedback, newest change first, with each permission's
// current state and the photo counts (feedback-admin.service.ts).
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await feedbackAdminService.list() });
  } catch (err) { next(err); }
});

// GET /api/admin/feedback/export
// The same list as a CSV download.
router.get('/export', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const csv = feedbackCsv(await feedbackAdminService.list());
    res
      .status(200)
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="e-velope-feedback-${new Date().toISOString().slice(0, 10)}.csv"`)
      .set('Cache-Control', 'no-store')
      .send(csv);
  } catch (err) { next(err); }
});

// GET /api/admin/feedback/:eventId/shareable-photos
// The event's shareable photos and short-lived download links.
router.get('/:eventId/shareable-photos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await feedbackAdminService.shareablePhotos(req.params['eventId'] as string) });
  } catch (err) { next(err); }
});

export default router;
