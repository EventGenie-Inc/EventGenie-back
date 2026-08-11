import { Router } from 'express';
import { memoryHubService } from './memory-hub.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
// mergeParams gives access to :eventId from parent router
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);
// ── Memory Hub ────────────────────────────
// GET /api/events/:eventId/memory-hub
router.get('/', async (req, res, next) => {
    try {
        const hub = await memoryHubService.getByEventId(req.params['eventId']);
        res.status(200).json({ status: 'ok', data: hub });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/events/:eventId/memory-hub
router.post('/', async (req, res, next) => {
    try {
        const auth = req;
        const hub = await memoryHubService.create(req.params['eventId'], auth.user.id, req.body);
        res.status(201).json({ status: 'ok', data: hub });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/events/:eventId/memory-hub/:id
router.put('/:id', async (req, res, next) => {
    try {
        const auth = req;
        const hub = await memoryHubService.update(req.params['id'], auth.user.id, req.body);
        res.status(200).json({ status: 'ok', data: hub });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/events/:eventId/memory-hub/:id/make-public
// Generates a shareable link token
router.post('/:id/make-public', async (req, res, next) => {
    try {
        const auth = req;
        const hub = await memoryHubService.makePublic(req.params['id'], auth.user.id);
        res.status(200).json({ status: 'ok', data: hub });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/events/:eventId/memory-hub/:id
router.delete('/:id', async (req, res, next) => {
    try {
        const auth = req;
        await memoryHubService.archive(req.params['id'], auth.user.id);
        res.status(200).json({ status: 'ok', message: 'Memory hub archived' });
    }
    catch (err) {
        next(err);
    }
});
// ── Memory Items ──────────────────────────
// GET /api/events/:eventId/memory-hub/:hubId/items
router.get('/:hubId/items', async (req, res, next) => {
    try {
        const items = await memoryHubService.getAllItems(req.params['hubId']);
        res.status(200).json({ status: 'ok', data: items });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/events/:eventId/memory-hub/:hubId/items/:id
router.get('/:hubId/items/:id', async (req, res, next) => {
    try {
        const item = await memoryHubService.getItemById(req.params['id']);
        res.status(200).json({ status: 'ok', data: item });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/events/:eventId/memory-hub/:hubId/items
router.post('/:hubId/items', async (req, res, next) => {
    try {
        const auth = req;
        const item = await memoryHubService.createItem(req.params['hubId'], auth.user.id, req.body);
        res.status(201).json({ status: 'ok', data: item });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/events/:eventId/memory-hub/:hubId/items/:id
router.put('/:hubId/items/:id', async (req, res, next) => {
    try {
        const auth = req;
        const item = await memoryHubService.updateItem(req.params['id'], auth.user.id, req.body);
        res.status(200).json({ status: 'ok', data: item });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/events/:eventId/memory-hub/:hubId/items/:id
router.delete('/:hubId/items/:id', async (req, res, next) => {
    try {
        const auth = req;
        await memoryHubService.archiveItem(req.params['id'], auth.user.id);
        res.status(200).json({ status: 'ok', message: 'Memory item archived' });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=memory-hub.router.js.map