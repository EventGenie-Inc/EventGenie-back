import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin, requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { designUploadSignatureLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { invitationStarterService } from './invitation-starter.service.js';

// ─────────────────────────────────────────
//  STARTER DESIGNS
//
//  /api/admin/invitation-starters (super admin only; anyone else gets the
//  global 404; every change audit-logged):
//    GET    /                        ?status&category&format
//    POST   /                        create (DRAFT)
//    PUT    /order                   { starterIds }
//    GET    /:id                     with its document
//    PUT    /:id                     update
//    DELETE /:id                     only one never published
//    POST   /:id/publish | /:id/unpublish | /:id/retire
//    POST   /:id/upload-signature    { purpose: 'ASSET' | 'PREVIEW' }
//
//  /api/invitation-starters (organisers, behind invitationDesigns, every plan):
//    GET    /                        ?category&format   published only
// ─────────────────────────────────────────

const wrap = (fn: (req: AuthenticatedRequest) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ status: 'ok', data: await fn(req as AuthenticatedRequest) });
    } catch (err) { next(err); }
  };

const id = (req: Request): string => req.params['id'] as string;

export const adminInvitationStarterRouter = Router();
adminInvitationStarterRouter.use(authenticate, requireSuperAdminHidden);

adminInvitationStarterRouter.get('/', wrap((req) => invitationStarterService.list(req.query as Record<string, unknown>)));
adminInvitationStarterRouter.post('/', wrap((req) => invitationStarterService.create(req.body, req.user.id), 201));
adminInvitationStarterRouter.put('/order', wrap((req) => invitationStarterService.reorder(req.body, req.user.id)));
adminInvitationStarterRouter.get('/:id', wrap((req) => invitationStarterService.get(id(req))));
adminInvitationStarterRouter.put('/:id', wrap((req) => invitationStarterService.update(id(req), req.body, req.user.id)));
adminInvitationStarterRouter.delete('/:id', wrap((req) => invitationStarterService.remove(id(req), req.user.id)));
adminInvitationStarterRouter.post('/:id/publish', wrap((req) => invitationStarterService.publish(id(req), req.user.id)));
adminInvitationStarterRouter.post('/:id/unpublish', wrap((req) => invitationStarterService.unpublish(id(req), req.user.id)));
adminInvitationStarterRouter.post('/:id/retire', wrap((req) => invitationStarterService.retire(id(req), req.user.id)));
adminInvitationStarterRouter.post(
  '/:id/upload-signature',
  designUploadSignatureLimiter,
  wrap((req) => invitationStarterService.requestUploadSignature(id(req), req.user.id, req.body))
);

export const invitationStarterRouter = Router();
invitationStarterRouter.use(authenticate, requireFeature('invitationDesigns'), requireEventAdmin);

invitationStarterRouter.get('/', wrap((req) => invitationStarterService.listPublished(req.query as Record<string, unknown>)));
