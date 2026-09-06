import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { addressAutosuggestLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { geocodingService } from './geocoding.service.js';
// ─────────────────────────────────────────
//  GEOCODING ROUTER
//
//  Proxies HERE address search. Any authenticated role may use these —
//  addresses are not tenant data, so there is deliberately no tenant
//  scoping here (unlike every other router in this codebase).
// ─────────────────────────────────────────
const router = Router();
router.get('/autosuggest', authenticate, addressAutosuggestLimiter, async (req, res, next) => {
    try {
        const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
        const results = await geocodingService.autosuggest(q);
        res.status(200).json({ status: 'ok', data: results });
    }
    catch (err) {
        next(err);
    }
});
router.get('/lookup', authenticate, async (req, res, next) => {
    try {
        const id = typeof req.query['id'] === 'string' ? req.query['id'] : '';
        const result = await geocodingService.lookup(id);
        res.status(200).json({ status: 'ok', data: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=geocoding.router.js.map