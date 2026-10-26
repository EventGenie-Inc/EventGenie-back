import { Router, type Request, type Response, type NextFunction } from 'express';
import { termsService } from './terms.service.js';
import { type AcceptTermsDto } from './terms.types.js';
import { authenticateAllowingPendingTerms } from '../../shared/middleware/auth.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// Signed-in users who have not accepted the current Terms yet must reach
// these two, so they skip the Terms check every other authenticated route
// makes (see auth.middleware.ts).
const router = Router();

router.use(authenticateAllowingPendingTerms);

// GET /api/terms/status -> { currentVersion, acceptedVersion, acceptedAt, mustAccept }
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const status = await termsService.getStatus(auth.user.id);
    res.status(200).json({ status: 'ok', data: status });
  } catch (err) { next(err); }
});

// POST /api/terms/accept  Body: { version }  -> the status after accepting
router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as Partial<AcceptTermsDto>;
    const status = await termsService.accept(auth.user.id, body.version);
    res.status(200).json({ status: 'ok', data: status });
  } catch (err) { next(err); }
});

export default router;
