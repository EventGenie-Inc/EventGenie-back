import { Router, type Request, type Response, type NextFunction } from 'express';
import { memoryHubService } from './memory-hub.service.js';
import { memoryHubGalleryLimiter, memoryHubGuestUploadLimiter } from '../../shared/middleware/rate-limit.middleware.js';

// Fully public/token-only surface — a guest holds either a gallery
// shareToken or an invite token, never platform credentials, so nothing
// here uses `authenticate`. Mounted separately from the admin-gated
// /api/events/:eventId/memory-hub router.
const router = Router();

// POST /api/memory-hub/guest-upload-signature
// { token, mediaType } — authenticated by invite token only, exactly
// like the RSVP endpoints. Rejects if the invite is invalid, the event
// is cancelled, or the hub isn't open yet — see memory-hub.service.ts.
router.post('/guest-upload-signature', memoryHubGuestUploadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await memoryHubService.requestGuestUploadSignature(req.body?.token, req.body?.mediaType);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

// POST /api/memory-hub/guest-items
// { token, mediaUrl, cloudinaryPublicId, mediaType, bytes, caption? }
// Persists a guest's already-uploaded item as PENDING.
router.post('/guest-items', memoryHubGuestUploadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await memoryHubService.createGuestItem(req.body);
    res.status(201).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// GET /api/memory-hub/:shareToken
// Public gallery — approved items only, no auth. Most exposed endpoint
// on the platform (see rate-limit.middleware.ts's comment).
router.get('/:shareToken', memoryHubGalleryLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await memoryHubService.viewByShareToken(req.params['shareToken'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
