import { Router, type Request, type Response, type NextFunction } from 'express';
import { rsvpResponseService } from './rsvp-response.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';

// mergeParams gives access to :inviteId from parent router
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

// Read-only — responses are created internally by the RSVP-submit
// transaction (POST /api/rsvp/submit), never through a public POST here.

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const responses = await rsvpResponseService.getAll(req.params['inviteId'] as string);
    res.status(200).json({ status: 'ok', data: responses });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const response = await rsvpResponseService.getById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: response });
  } catch (err) { next(err); }
});

export default router;
