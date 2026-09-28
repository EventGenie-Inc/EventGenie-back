import { Router } from 'express';
import { programItemService } from './program-item.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
// mergeParams gives access to :eventId and :programId from the parent mount path
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);
router.get('/', async (req, res, next) => {
    try {
        const auth = req;
        const items = await programItemService.getAll(req.params['eventId'], req.params['programId'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: items });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const item = await programItemService.getById(req.params['id'], req.params['eventId'], req.params['programId'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: item });
    }
    catch (err) {
        next(err);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const auth = req;
        const item = await programItemService.create(req.params['eventId'], req.params['programId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: item });
    }
    catch (err) {
        next(err);
    }
});
router.put('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const item = await programItemService.update(req.params['id'], req.params['eventId'], req.params['programId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: item });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const auth = req;
        await programItemService.archive(req.params['id'], req.params['eventId'], req.params['programId'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'Program item archived' });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=program-item.router.js.map