import { Router, type Request, type Response, type NextFunction } from 'express';
import { reminderScheduleService } from './reminder-schedule.service.js';
import { type CreateReminderScheduleInput } from './reminder-schedule.types.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// /api/events/:eventId/reminder-schedules — reminders to every guest who
// hasn't replied, sent on a schedule (reminder-schedule.service.ts).
const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('scheduledReminders'), requireEventAdmin);

// Every schedule of the event, with counts by status.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await reminderScheduleService.list(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// Body: { preset: 'IN_1_DAY' | 'IN_1_WEEK' | 'IN_1_MONTH' } or
// { preset: 'CUSTOM', sendAt: '2026-11-20T09:00' } (South African time).
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await reminderScheduleService.create(
      req.params['eventId'] as string, (req.body ?? {}) as CreateReminderScheduleInput, auth.user.id, auth.user.role, auth.user.tenantId
    );
    res.status(201).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// Cancels one that hasn't gone yet.
router.post('/:scheduleId/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await reminderScheduleService.cancel(
      req.params['eventId'] as string, req.params['scheduleId'] as string, auth.user.id, auth.user.role, auth.user.tenantId
    );
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
