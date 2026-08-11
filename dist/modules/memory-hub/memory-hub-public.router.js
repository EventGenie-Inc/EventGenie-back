import { Router } from 'express';
import { memoryHubService } from './memory-hub.service.js';
// Public, unauthenticated view surface — a guest only has a shareToken,
// never an eventId, so this is mounted separately from the admin-gated
// /api/events/:eventId/memory-hub router.
const router = Router();
// GET /api/memory-hub/:shareToken
router.get('/:shareToken', async (req, res, next) => {
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