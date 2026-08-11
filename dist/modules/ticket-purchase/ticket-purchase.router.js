import { Router } from 'express';
import { ticketPurchaseService } from './ticket-purchase.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
const router = Router();
router.use(authenticate, requireEventAdmin);
// Read-only — purchases are created internally by the RSVP-submit
// transaction (POST /api/rsvp/submit), never through a public POST here.
// This prevents overselling a ticket's totalQuantity outside that
// capacity-checked flow.
router.get('/invite/:inviteId', async (req, res, next) => {
    try {
        const purchases = await ticketPurchaseService.getAll(req.params['inviteId']);
        res.status(200).json({ status: 'ok', data: purchases });
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const purchase = await ticketPurchaseService.getById(req.params['id']);
        res.status(200).json({ status: 'ok', data: purchase });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=ticket-purchase.router.js.map