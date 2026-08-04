import { Router } from 'express';
import { subscriptionTierConfigService } from './subscription-tier-config.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '@prisma/client';
const router = Router();
// All subscription tier config routes are SUPER_ADMIN only —
// this is platform-level configuration, not tenant-level
router.use(authenticate, requireSuperAdmin);
// GET /api/subscription-tiers
// Returns all three tier configurations
router.get('/', async (_req, res, next) => {
    try {
        const configs = await subscriptionTierConfigService.getAll();
        res.status(200).json({ status: 'ok', data: configs });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/subscription-tiers/:tier
// tier param: SPARK | CELEBRATE | ELEVATE
router.get('/:tier', async (req, res, next) => {
    try {
        const tier = req.params['tier'];
        const config = await subscriptionTierConfigService.getByTier(tier);
        res.status(200).json({ status: 'ok', data: config });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/subscription-tiers
// Creates a tier config — used during initial platform setup
router.post('/', async (req, res, next) => {
    try {
        const config = await subscriptionTierConfigService.create(req.body);
        res.status(201).json({ status: 'ok', data: config });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/subscription-tiers/:tier
// Updates limits and feature flags for a tier
router.put('/:tier', async (req, res, next) => {
    try {
        const tier = req.params['tier'];
        const config = await subscriptionTierConfigService.update(tier, req.body);
        res.status(200).json({ status: 'ok', data: config });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=subscription-tier-config.router.js.map