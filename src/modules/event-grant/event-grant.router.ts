import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { eventGrantService } from './event-grant.service.js';

// ─────────────────────────────────────────
//  EVENT TEMPLATES AND GRANTS (super admin only, behind customTiers; anyone
//  else gets the global 404)
//  /api/admin/event-templates/organisation   GET  the internal organisation { id, name }
//  /api/admin/event-templates                GET  its events; POST a new one (POST /api/events' body)
//  /api/admin/event-grants                   GET  every grant; POST grant a template
//  /api/admin/event-grants/:id               GET  one, with its recipients
//  /api/admin/event-grants/:id/recipients    POST { tenantIds } more chosen tenants
// ─────────────────────────────────────────

export const eventTemplateRouter = Router();
eventTemplateRouter.use(authenticate, requireFeature('customTiers'), requireSuperAdminHidden);

eventTemplateRouter.get('/organisation', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await eventGrantService.getTemplateOrganisation() });
  } catch (err) { next(err); }
});

eventTemplateRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await eventGrantService.listTemplates() });
  } catch (err) { next(err); }
});

eventTemplateRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(201).json({ status: 'ok', data: await eventGrantService.createTemplate(req.body, auth.user.id) });
  } catch (err) { next(err); }
});

export const eventGrantRouter = Router();
eventGrantRouter.use(authenticate, requireFeature('customTiers'), requireSuperAdminHidden);

eventGrantRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await eventGrantService.list() });
  } catch (err) { next(err); }
});

eventGrantRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(201).json({ status: 'ok', data: await eventGrantService.create(req.body, auth.user.id) });
  } catch (err) { next(err); }
});

eventGrantRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await eventGrantService.get(req.params['id'] as string) });
  } catch (err) { next(err); }
});

eventGrantRouter.post('/:id/recipients', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    res.status(200).json({ status: 'ok', data: await eventGrantService.addRecipients(req.params['id'] as string, req.body, auth.user.id) });
  } catch (err) { next(err); }
});
