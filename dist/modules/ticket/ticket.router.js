import { Router } from 'express';
import { ticketService } from './ticket.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
// mergeParams gives access to :eventId from parent router.
//
// Organiser-only, every route — including the reads, which used to be
// public. No guest path reads tickets here (see ticket.service.ts): guests
// get theirs through their invite token on /api/rsvp.
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);
router.get('/', async (req, res, next) => {
    try {
        const auth = req;
        const tickets = await ticketService.getAllForAdmin(req.params['eventId'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: tickets });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const ticket = await ticketService.getById(req.params['id'], req.params['eventId'], auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', data: ticket });
    }
    catch (err) {
        next(err);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const auth = req;
        const ticket = await ticketService.create(req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: ticket });
    }
    catch (err) {
        next(err);
    }
});
router.put('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const ticket = await ticketService.update(req.params['id'], req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(200).json({ status: 'ok', data: ticket });
    }
    catch (err) {
        next(err);
    }
});
router.delete('/:id', async (req, res, next) => {
    try {
        const auth = req;
        await ticketService.archive(req.params['id'], req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId);
        res.status(200).json({ status: 'ok', message: 'Ticket archived' });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=ticket.router.js.map