import { Router } from 'express';
import { rsvpFieldService } from './rsvp-field.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);
router.get('/', async (req, res, next) => {
    try {
        const auth = req;
        const fields = await rsvpFieldService.getAll(req.params['eventId'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: fields });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const field = await rsvpFieldService.getById(req.params['id'], req.params['eventId'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: field });
    }
    catch (err) {
        next(err);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const auth = req;
        const field = await rsvpFieldService.create(req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: field });
    }
    catch (err) {
        next(err);
    }
});
router.put('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const field = await rsvpFieldService.update(req.params['id'], req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: field });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const auth = req;
        await rsvpFieldService.archive(req.params['id'], req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'RSVP field archived' });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=rsvp-field.router.js.map