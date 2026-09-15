import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventDraftService } from './event-draft.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

router.get('/current', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenantId = auth.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const draft = await eventDraftService.getCurrentDraft(tenantId, auth.user.id);
    res.status(200).json({ status: 'ok', data: draft });
  } catch (err) { next(err); }
});

router.put('/current', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenantId = auth.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const draft = await eventDraftService.saveDraft(tenantId, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: draft });
  } catch (err) { next(err); }
});

router.delete('/current', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenantId = auth.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    await eventDraftService.discardDraft(tenantId, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Draft discarded' });
  } catch (err) { next(err); }
});

router.post('/current/materialize', authenticate, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const tenantId = auth.user.tenantId;
    if (!tenantId) {
      res.status(400).json({ status: 'error', message: 'User has no associated tenant' });
      return;
    }
    const event = await eventDraftService.materialize(tenantId, auth.user.id);
    res.status(201).json({ status: 'ok', data: { event } });
  } catch (err) { next(err); }
});

export default router;
