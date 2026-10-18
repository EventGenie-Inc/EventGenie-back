import { Router, type Request, type Response, type NextFunction } from 'express';
import { registrationSettingsService } from './registration-settings.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId from the parent mount path.
// Public registration's settings belong to publicEvents: off, this is a
// 404 like every other route of the feature.
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('publicEvents'), requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const settings = await registrationSettingsService.get(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: settings });
  } catch (err) { next(err); }
});

router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const settings = await registrationSettingsService.update(
      req.params['eventId'] as string,
      auth.user.id,
      auth.user.role,
      auth.user.tenantId,
      req.body
    );
    res.status(200).json({ status: 'ok', data: settings });
  } catch (err) { next(err); }
});

export default router;
