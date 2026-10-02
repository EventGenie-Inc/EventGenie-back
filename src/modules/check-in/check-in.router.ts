import { Router, type Request, type Response, type NextFunction } from 'express';
import { checkInService } from './check-in.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { type CheckInInput } from './check-in.types.js';

// Mounted at /api/events/:eventId/check-in — deliberately NOT under /days,
// whose router authenticates every request under it; this one authenticates
// once. The people using it are Tenant Admins and Event Admins signed in on a
// phone at the door — there is no separate door-staff role.
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

// The door list + counts for one day.
router.get('/days/:dayId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const roster = await checkInService.getDayRoster(
      req.params['eventId'] as string, req.params['dayId'] as string, auth.user.role, auth.user.tenantId
    );
    res.status(200).json({ status: 'ok', data: roster });
  } catch (err) { next(err); }
});

// Check a guest in for the day. Body: { guestId } or { inviteToken } — exactly
// one. 201 when newly checked in, 200 when they already were (idempotent).
router.post('/days/:dayId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await checkInService.checkIn(
      req.params['eventId'] as string, req.params['dayId'] as string,
      (req.body ?? {}) as CheckInInput, auth.user.id, auth.user.role, auth.user.tenantId
    );
    res.status(result.created ? 201 : 200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// Undo a check-in (hard delete). 200 either way; `removed` says whether there
// was anything to remove.
router.delete('/days/:dayId/guests/:guestId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await checkInService.undo(
      req.params['eventId'] as string, req.params['dayId'] as string, req.params['guestId'] as string,
      auth.user.role, auth.user.tenantId
    );
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
