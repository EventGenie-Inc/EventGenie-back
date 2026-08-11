import { Router, type Request, type Response, type NextFunction } from 'express';
import { memoryHubService } from './memory-hub.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

// mergeParams gives access to :eventId from parent router
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

// ── Memory Hub ────────────────────────────

// GET /api/events/:eventId/memory-hub
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hub = await memoryHubService.getByEventId(req.params['eventId'] as string);
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.create(
      req.params['eventId'] as string,
      auth.user.id,
      req.body
    );
    res.status(201).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// PUT /api/events/:eventId/memory-hub/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.update(
      req.params['id'] as string,
      auth.user.id,
      req.body
    );
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:id/make-public
// Generates a shareable link token
router.post('/:id/make-public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.makePublic(
      req.params['id'] as string,
      auth.user.id
    );
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// DELETE /api/events/:eventId/memory-hub/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await memoryHubService.archive(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Memory hub archived' });
  } catch (err) { next(err); }
});

// ── Memory Items ──────────────────────────

// GET /api/events/:eventId/memory-hub/:hubId/items
router.get('/:hubId/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await memoryHubService.getAllItems(req.params['hubId'] as string);
    res.status(200).json({ status: 'ok', data: items });
  } catch (err) { next(err); }
});

// GET /api/events/:eventId/memory-hub/:hubId/items/:id
router.get('/:hubId/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await memoryHubService.getItemById(req.params['id'] as string);
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:hubId/items
router.post('/:hubId/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.createItem(
      req.params['hubId'] as string,
      auth.user.id,
      req.body
    );
    res.status(201).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// PUT /api/events/:eventId/memory-hub/:hubId/items/:id
router.put('/:hubId/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.updateItem(
      req.params['id'] as string,
      auth.user.id,
      req.body
    );
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// DELETE /api/events/:eventId/memory-hub/:hubId/items/:id
router.delete('/:hubId/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await memoryHubService.archiveItem(req.params['id'] as string, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'Memory item archived' });
  } catch (err) { next(err); }
});

export default router;