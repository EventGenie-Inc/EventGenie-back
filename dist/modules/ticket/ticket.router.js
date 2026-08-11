import { Router } from 'express';
import { ticketService } from './ticket.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
// mergeParams gives access to :eventId from parent router
const router = Router({ mergeParams: true });
// Public reads — guests browsing an event need to see purchasable tickets
// with no auth. No router.use(authenticate, ...) at the top of this file.
router.get('/', async (req, res, next) => {
    try {
        const tickets = await ticketService.getAllPublic(req.params['eventId']);
        res.status(200).json({ status: 'ok', data: tickets });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const ticket = await ticketService.getById(req.params['id']);
        res.status(200).json({ status: 'ok', data: ticket });
    }
    catch (err) {
        next(err);
    }
});
router.post('/', authenticate, requireEventAdmin, async (req, res, next) => {
    try {
        const auth = req;
        const ticket = await ticketService.create(req.params['eventId'], auth.user.id, req.body);
        res.status(201).json({ status: 'ok', data: ticket });
    }
    catch (err) {
        next(err);
    }
});
router.put('/:id', authenticate, requireEventAdmin, async (req, res, next) => {
    try {
        const auth = req;
        const ticket = await ticketService.update(req.params['id'], auth.user.id, req.body);
        res.status(200).json({ status: 'ok', data: ticket });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/:id', authenticate, requireEventAdmin, async (req, res, next) => {
    try {
        const auth = req;
        await ticketService.archive(req.params['id'], auth.user.id);
        res.status(200).json({ status: 'ok', message: 'Ticket archived' });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=ticket.router.js.map