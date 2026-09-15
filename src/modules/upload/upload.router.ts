import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { uploadSignatureLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { uploadService } from './upload.service.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();

// Any role that can create an event may request an upload signature —
// same guard as POST /api/events.
router.post('/signature', authenticate, requireEventAdmin, uploadSignatureLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await uploadService.requestSignature(auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
