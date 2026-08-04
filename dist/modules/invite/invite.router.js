import { Router } from 'express';
import { inviteService } from './invite.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);
router.get('/', async (req, res, next) => {
    try {
        const invites = await inviteService.getAll(req.params['eventId']);
        res.status(200).json({ status: 'ok', data: invites });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const invite = await inviteService.getById(req.params['id']);
        res.status(200).json({ status: 'ok', data: invite });
    }
    catch (err) {
        next(err);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const auth = req;
        const invite = await inviteService.create(req.params['eventId'], auth.user.id, req.body);
        res.status(201).json({ status: 'ok', data: invite });
    }
    catch (err) {
        next(err);
    }
});
router.put('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const invite = await inviteService.update(req.params['id'], auth.user.id, req.body);
        res.status(200).json({ status: 'ok', data: invite });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const auth = req;
        await inviteService.archive(req.params['id'], auth.user.id);
        res.status(200).json({ status: 'ok', message: 'Invite archived' });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=invite.router.js.map