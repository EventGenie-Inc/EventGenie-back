import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { adminConsoleService } from './admin-console.service.js';

// ─────────────────────────────────────────
//  THE SUPER ADMIN CONSOLE (STEERING "Super admin console"). Read only:
//  GETs, nothing written but the guest list's audit entry. Super admin
//  only; anyone else gets the global 404.
//  /api/admin/stats                    GET  the dashboard's numbers
//  /api/admin/users                    GET  every user, paged
//  /api/admin/events                   GET  every event (no templates), paged
//  /api/admin/events/:eventId          GET  one event: details, days, stats
//  /api/admin/events/:eventId/guests   GET  its guests, paged (audit-logged)
//
//  Mounted at /api/admin with the guards on each route, not router.use, so
//  a request for another /api/admin router's path passes straight through.
// ─────────────────────────────────────────

const router = Router();
const guard = [authenticate, requireSuperAdminHidden];

router.get('/stats', ...guard, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await adminConsoleService.stats() });
  } catch (err) { next(err); }
});

router.get('/users', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await adminConsoleService.listUsers(req.query) });
  } catch (err) { next(err); }
});

router.get('/events', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await adminConsoleService.listEvents(req.query) });
  } catch (err) { next(err); }
});

router.get('/events/:eventId', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await adminConsoleService.getEvent(req.params['eventId'] as string) });
  } catch (err) { next(err); }
});

router.get('/events/:eventId/guests', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await adminConsoleService.listGuests(req.params['eventId'] as string, req.query, auth.user.id) });
  } catch (err) { next(err); }
});

export default router;
