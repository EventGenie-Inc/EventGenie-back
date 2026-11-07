import { Router, type Request, type Response, type NextFunction } from 'express';
import { registrationApprovalService } from './registration-approval.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// /api/events/:eventId/registrations: an organiser deciding on public
// registrations awaiting approval (registration-approval.service.ts).
// Part of publicEvents: off, every route here is the global 404.
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('publicEvents'), requireEventAdmin);

// GET /pending -> { registrations: PendingRegistration[] }
router.get('/pending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const data = await registrationApprovalService.listPending(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data });
  } catch (err) { next(err); }
});

// POST /:guestId/approve and /:guestId/decline, no body
// -> { guestId, decision: 'APPROVED' | 'DECLINED', emailSent }
for (const action of ['approve', 'decline'] as const) {
  router.post(`/:guestId/${action}`, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req as AuthenticatedRequest;
      const data = await registrationApprovalService[action](
        req.params['eventId'] as string,
        req.params['guestId'] as string,
        auth.user.id,
        auth.user.role,
        auth.user.tenantId
      );
      res.status(200).json({ status: 'ok', data });
    } catch (err) { next(err); }
  });
}

export default router;
