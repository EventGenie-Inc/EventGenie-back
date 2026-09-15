import { Router } from 'express';
import { inviteService } from './invite.service.js';
import { inviteDispatchService } from './invite-dispatch.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);
router.get('/', async (req, res, next) => {
    try {
        const auth = req;
        const invites = await inviteService.getAll(req.params['eventId'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: invites });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const invite = await inviteService.getById(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: invite });
    }
    catch (err) {
        next(err);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const auth = req;
        const invite = await inviteService.create(req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: invite });
    }
    catch (err) {
        next(err);
    }
});
router.put('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const invite = await inviteService.update(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: invite });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const auth = req;
        await inviteService.archive(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'Invite archived' });
    }
    catch (err) {
        next(err);
    }
});
router.post('/:id/reactivate', async (req, res, next) => {
    try {
        const auth = req;
        const invite = await inviteService.reactivate(req.params['id'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: invite });
    }
    catch (err) {
        next(err);
    }
});
router.post('/send', async (req, res, next) => {
    try {
        const auth = req;
        const { guestIds } = req.body;
        const result = await inviteDispatchService.sendBulk(req.params['eventId'], guestIds, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: result });
    }
    catch (err) {
        next(err);
    }
});
router.post('/:id/resend', async (req, res, next) => {
    try {
        const auth = req;
        const result = await inviteDispatchService.resend(req.params['id'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=invite.router.js.map