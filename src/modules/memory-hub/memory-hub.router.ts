import { Router, type Request, type Response, type NextFunction } from 'express';
import { memoryHubService } from './memory-hub.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { HttpError } from '../../shared/errors/http-error.js';

const VALID_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
type MemoryItemStatusFilter = (typeof VALID_STATUSES)[number];

const parseStatusFilter = (raw: unknown): MemoryItemStatusFilter | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && (VALID_STATUSES as readonly string[]).includes(raw)) {
    return raw as MemoryItemStatusFilter;
  }
  throw new HttpError(400, `status must be one of: ${VALID_STATUSES.join(', ')}`);
};

// mergeParams gives access to :eventId from parent router. Every route
// here is organiser-facing (authenticated, tenant-scoped) — the guest
// upload path and public gallery live in memory-hub-public.router.ts.
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

// ── Memory Hub ────────────────────────────

// GET /api/events/:eventId/memory-hub
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.getByEventId(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub
// Defensive/repair only — every event gets one automatically at
// creation now (event.repository.ts's create(), and the wizard's
// materialize path). 409s if one already exists.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.create(
      req.params['eventId'] as string,
      auth.user.id,
      auth.user.role,
      auth.user.tenantId,
      req.body
    );
    res.status(201).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// PUT /api/events/:eventId/memory-hub/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.update(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:id/share-link
// Generates (first time) or regenerates (any later time) the public
// share token — regenerating invalidates the previous link.
router.post('/:id/share-link', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.regenerateShareLink(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// DELETE /api/events/:eventId/memory-hub/:id/share-link
// Revokes the link — a link that cannot be un-shared is a problem the
// first time one is posted somewhere it shouldn't be.
router.delete('/:id/share-link', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.revokeShareLink(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// DELETE /api/events/:eventId/memory-hub/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await memoryHubService.archive(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', message: 'Memory hub archived' });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:id/reactivate
router.post('/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const hub = await memoryHubService.reactivate(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: hub });
  } catch (err) { next(err); }
});

// ── Memory Items ──────────────────────────

// GET /api/events/:eventId/memory-hub/:hubId/items?status=PENDING
router.get('/:hubId/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const status = parseStatusFilter(req.query['status']);
    const items = await memoryHubService.getAllItems(req.params['hubId'] as string, auth.user.role, auth.user.tenantId, status);
    res.status(200).json({ status: 'ok', data: items });
  } catch (err) { next(err); }
});

// GET /api/events/:eventId/memory-hub/:hubId/items/:id
router.get('/:hubId/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.getItemById(req.params['id'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:hubId/items
// Organiser upload persist — lands APPROVED immediately.
router.post('/:hubId/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.createOrganiserItem(
      req.params['hubId'] as string,
      auth.user.id,
      auth.user.role,
      auth.user.tenantId,
      req.body
    );
    res.status(201).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// PUT /api/events/:eventId/memory-hub/:hubId/items/:id
// Caption only — curation is its own action below, not smuggled through here.
router.put('/:hubId/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.updateItem(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:hubId/items/:id/approve
router.post('/:hubId/items/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.curateItem(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId, 'APPROVED');
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:hubId/items/:id/reject
// Hides the item and frees its quota — does NOT delete the Cloudinary
// asset (see memory-hub.service.ts's curateItem comment).
router.post('/:hubId/items/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.curateItem(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId, 'REJECTED');
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

// DELETE /api/events/:eventId/memory-hub/:hubId/items/:id
router.delete('/:hubId/items/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await memoryHubService.archiveItem(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', message: 'Memory item archived' });
  } catch (err) { next(err); }
});

// POST /api/events/:eventId/memory-hub/:hubId/items/:id/reactivate
router.post('/:hubId/items/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const item = await memoryHubService.reactivateItem(req.params['id'] as string, auth.user.id, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: item });
  } catch (err) { next(err); }
});

export default router;
