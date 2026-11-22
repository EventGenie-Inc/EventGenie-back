import { Router, type Request, type Response, type NextFunction } from 'express';
import { checkInService } from './check-in.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { type CheckInInput } from './check-in.types.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { checkInScanLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { checkInScanService } from '../check-in-pass/check-in-scan.service.js';
import { type ScanInput } from '../check-in-pass/check-in-pass.types.js';

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

// Scan a check-in code (QR check-in). Body: { eventDayId, payload }.
// Always 200 with GREEN / AMBER / RED and a reason (check-in-scan.service.ts);
// a GREEN writes the same CheckIn row as the guest list's check-in above,
// and the undo below removes it either way. Behind qrCheckIn, limited per
// signed-in user.
router.post('/scan', requireFeature('qrCheckIn'), checkInScanLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await checkInScanService.scan(
      req.params['eventId'] as string, (req.body ?? {}) as ScanInput, auth.user.id, auth.user.role, auth.user.tenantId
    );
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ status: 'ok', data: result });
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

// Undo a ticket's check-in for the day (ticket sales Round B).
router.delete('/days/:dayId/tickets/:ticketId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await checkInService.undoTicket(
      req.params['eventId'] as string,
      req.params['dayId'] as string,
      req.params['ticketId'] as string,
      auth.user.role,
      auth.user.tenantId
    );
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
