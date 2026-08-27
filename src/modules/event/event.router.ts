import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventService } from './event.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin, requireEventAdminOrVendor } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

router.get('/', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const events = await eventService.getAll(auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: events });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, requireEventAdminOrVendor, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const event = await eventService.getById(req.params['id'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.get('/:id/share-link', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await eventService.getShareLink(req.params['id'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenantId = auth.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const event = await eventService.create(tenantId, auth.user.id, req.body);
    res.status(201).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const event = await eventService.update(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data: event });
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await eventService.archive(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', message: 'Event archived' });
  } catch (err) { next(err); }
});

export default router;