import { Router } from 'express';
import { guestService } from './guest.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
const router = Router();
router.use(authenticate, requireEventAdmin);
router.get('/', async (req, res, next) => {
    try {
        const auth = req;
        const includeArchived = req.query['includeArchived'] === 'true';
        const guests = await guestService.getAll(auth.user.role, auth.user.tenantId, includeArchived);
        res.status(200).json({ status: 'ok', data: guests });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const guest = await guestService.getById(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: guest });
    }
    catch (err) {
        next(err);
    }
});
router.put('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const guest = await guestService.update(req.params['id'], auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: guest });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const auth = req;
        await guestService.archive(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'Guest archived' });
    }
    catch (err) {
        next(err);
    }
});
router.post('/:id/reactivate', async (req, res, next) => {
    try {
        const auth = req;
        const guest = await guestService.reactivate(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: guest });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=guest.router.js.map