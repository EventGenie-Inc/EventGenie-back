import { Router, type Request, type Response, type NextFunction } from 'express';
import { attendanceService } from './attendance.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();
router.use(authenticate, requireEventAdmin);

// Get all attendance records for an invite
router.get('/invite/:inviteId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const records = await attendanceService.getAll(
      req.params['inviteId'] as string, auth.user.role, auth.user.tenantId
    );
    res.status(200).json({ status: 'ok', data: records });
  } catch (err) { next(err); }
});

// Get single attendance record
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const record = await attendanceService.getById(
      req.params['id'] as string, auth.user.role, auth.user.tenantId
    );
    res.status(200).json({ status: 'ok', data: record });
  } catch (err) { next(err); }
});

// Record attendance
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const { inviteId, eventDayId } = req.body as { inviteId: string; eventDayId: string };
    const record = await attendanceService.create(
      inviteId, eventDayId, auth.user.role, auth.user.tenantId
    );
    res.status(201).json({ status: 'ok', data: record });
  } catch (err) { next(err); }
});

// Remove attendance record (hard delete — fact record)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await attendanceService.delete(req.params['id'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', message: 'Attendance record removed' });
  } catch (err) { next(err); }
});

export default router;
