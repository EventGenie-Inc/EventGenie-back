import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { adminAuditService } from './admin-audit.service.js';

// ─────────────────────────────────────────
//  THE AUDIT LOG (super admin only; anyone else gets the global 404)
//  /api/admin/tenants/:tenantId/audit-log  GET — one tenant's entries
//  /api/admin/audit-log                    GET — every entry (?scope=platform:
//                                                the platform-wide ones)
//  Both newest first, ?limit (default 100, at most 500) and ?before (an
//  entry's createdAt, for the next page).
// ─────────────────────────────────────────

export const tenantAuditLogRouter = Router({ mergeParams: true });
tenantAuditLogRouter.use(authenticate, requireSuperAdminHidden);
tenantAuditLogRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entries = await adminAuditService.listForTenant(req.params['tenantId'] as string, req.query);
    res.status(200).json({ status: 'ok', data: entries });
  } catch (err) { next(err); }
});

export const auditLogRouter = Router();
auditLogRouter.use(authenticate, requireSuperAdminHidden);
auditLogRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({ status: 'ok', data: await adminAuditService.list(req.query) });
  } catch (err) { next(err); }
});
