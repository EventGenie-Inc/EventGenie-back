import { Router, type Request, type Response, type NextFunction } from 'express';
import { memoryHubDownloadService } from './memory-hub-download.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { memoryHubDownloadLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// Its own router, mounted before memory-hub.router.ts, so the feature guard
// sits between authenticate and the role gate (feature.middleware.ts):
// the Memory Hub router applies its role gate to every route at once.
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('memoryHubDownload'), requireEventAdmin);

// POST /api/events/:eventId/memory-hub/download
// Zip links for every approved item (memory-hub-download.service.ts).
router.post('/', memoryHubDownloadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await memoryHubDownloadService.downloadAll(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
