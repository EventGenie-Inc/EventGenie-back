import { Router } from 'express';
import { tenantService } from './tenant.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
const router = Router();
// All tenant routes are SUPER_ADMIN only
router.use(authenticate, requireSuperAdmin);
router.get('/', async (_req, res, next) => {
    try {
        const tenants = await tenantService.getAll();
        res.status(200).json({ status: 'ok', data: tenants });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const tenant = await tenantService.getById(req.params['id']);
        res.status(200).json({ status: 'ok', data: tenant });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id/users', async (req, res, next) => {
    try {
        const users = await tenantService.getUsers(req.params['id']);
        res.status(200).json({ status: 'ok', data: users });
    }
    catch (err) {
        next(err);
    }
});
router.post('/:id/suspend', async (req, res, next) => {
    try {
        const auth = req;
        const tenant = await tenantService.suspend(req.params['id'], auth.user.id);
        res.status(200).json({ status: 'ok', data: tenant });
    }
    catch (err) {
        next(err);
    }
});
router.post('/:id/reactivate', async (req, res, next) => {
    try {
        const auth = req;
        const tenant = await tenantService.reactivate(req.params['id'], auth.user.id);
        res.status(200).json({ status: 'ok', data: tenant });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=tenant.router.js.map