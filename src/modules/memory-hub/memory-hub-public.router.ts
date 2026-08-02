import { Router, type Request, type Response, type NextFunction } from 'express';
import { memoryHubService } from './memory-hub.service.js';

// Public, unauthenticated view surface — a guest only has a shareToken,
// never an eventId, so this is mounted separately from the admin-gated
// /api/events/:eventId/memory-hub router.
const router = Router();

// GET /api/memory-hub/:shareToken
router.get('/:shareToken', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await memoryHubService.viewByShareToken(req.params['shareToken'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
