import { Router } from 'express';
import { memoryHubService } from './memory-hub.service.js';
import { memoryHubGalleryLimiter, memoryHubGuestUploadLimiter, memoryHubGuestUploadIpLimiter, memoryHubGuestViewLimiter, } from '../../shared/middleware/rate-limit.middleware.js';
// Fully public/token-only surface — a guest holds either a gallery
// shareToken or an invite token, never platform credentials, so nothing
// here uses `authenticate`. Mounted separately from the admin-gated
// /api/events/:eventId/memory-hub router.
const router = Router();
// POST /api/memory-hub/guest-upload-signature
// { token, mediaType } — authenticated by invite token only, exactly
// like the RSVP endpoints. Rejects if the invite is invalid, the event
// is cancelled, or the album isn't open yet — see memory-hub.service.ts.
// Two limiters stacked — the per-invite budget (the real ceiling) and
// the per-IP abuse backstop (failures only) — see
// rate-limit.middleware.ts's header comment on why a single IP-keyed
// limiter unfairly shared one budget across an entire shared-WiFi/NAT
// event.
router.post('/guest-upload-signature', memoryHubGuestUploadIpLimiter, memoryHubGuestUploadLimiter, async (req, res, next) => {
    try {
        const result = await memoryHubService.requestGuestUploadSignature(req.body?.token, req.body?.mediaType);
        res.status(200).json({ status: 'ok', data: result });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/memory-hub/guest-items
// { token, mediaUrl, cloudinaryPublicId, mediaType, bytes, caption? }
// Persists a guest's already-uploaded item as PENDING. Same two
// stacked limiters as guest-upload-signature above.
router.post('/guest-items', memoryHubGuestUploadIpLimiter, memoryHubGuestUploadLimiter, async (req, res, next) => {
    try {
        const item = await memoryHubService.createGuestItem(req.body);
        res.status(201).json({ status: 'ok', data: item });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/memory-hub/guest-view
// { token } — Contract B. Tells the guest's page whether to show a
// photo album tab at all, plus the approved gallery and the guest's own
// pending uploads, with no upload signature required to render. Its own
// limiter — sized for page loads, never shares the upload limiters'
// budgets. See memory-hub.service.ts's getGuestView.
router.post('/guest-view', memoryHubGuestViewLimiter, async (req, res, next) => {
    try {
        const result = await memoryHubService.getGuestView(req.body?.token);
        res.status(200).json({ status: 'ok', data: result });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/memory-hub/:shareToken
// Public gallery — approved items only, no auth. Most exposed endpoint
// on the platform (see rate-limit.middleware.ts's comment).
router.get('/:shareToken', memoryHubGalleryLimiter, async (req, res, next) => {
    try {
        const result = await memoryHubService.viewByShareToken(req.params['shareToken']);
        res.status(200).json({ status: 'ok', data: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=memory-hub-public.router.js.map