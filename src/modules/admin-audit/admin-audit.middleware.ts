import { type Request, type Response, type NextFunction } from 'express';
import { adminAuditService } from './admin-audit.service.js';
import { adminAuditRepository } from './admin-audit.repository.js';
import { runWithAuditState } from './admin-audit.context.js';
import { ADMIN_AUDIT_ACTIONS } from './admin-audit.types.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';

// ─────────────────────────────────────────
//  THE CATCH-ALL: every other super admin write is recorded too.
//
//  A super admin can act through any organiser route (editing an event,
//  removing a guest, changing a user), not only the super admin ones. The
//  services written for super admins record their own entries, with the
//  details only they know (admin-audit.service.ts's record). Any other
//  write that a SUPER_ADMIN makes and that succeeds (2xx) is recorded here,
//  after the response: the method, the path, the fields the body carried
//  (names only, never values: a body can carry personal details) and the
//  status, against the tenant its path names where one does (an event, a
//  tenant, a user, a guest, a vendor space), else no tenant.
//
//  Not recorded: reads (GET, HEAD, OPTIONS), sign-in and session routes
//  (/api/auth), accepting the Terms (/api/terms), refusals, and a write
//  whose service already recorded it. Recording never fails the request: a
//  failed write is reported to error monitoring.
//
//  Mounted on /api before every router, so it sees the request before
//  `authenticate` has run; it reads the signed-in user when the response
//  finishes.
// ─────────────────────────────────────────

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const NOT_RECORDED_PREFIXES = ['/api/auth', '/api/terms'];

const pathOf = (req: Request): string => req.originalUrl.split('?')[0] ?? req.originalUrl;

// The tenant a path's first record belongs to, where one can be told.
export const tenantForPath = async (path: string): Promise<string | null> => {
  const [, api, resource, id] = path.split('/');
  if (api !== 'api' || !id) return null;
  if (resource === 'events') return adminAuditRepository.tenantOfEvent(id);
  if (resource === 'tenants' && id !== 'me') return (await adminAuditRepository.tenantExists(id)) ? id : null;
  if (resource === 'users') return adminAuditRepository.tenantOfUser(id);
  if (resource === 'guests') return adminAuditRepository.tenantOfGuest(id);
  if (resource === 'vendors') return adminAuditRepository.tenantOfVendorSpace(id);
  return null;
};

export const recordSuperAdminWrites = (req: Request, res: Response, next: NextFunction): void => {
  if (READ_METHODS.has(req.method) || NOT_RECORDED_PREFIXES.some((prefix) => pathOf(req).startsWith(prefix))) {
    next();
    return;
  }

  const { state } = runWithAuditState(() => next());

  res.on('finish', () => {
    const user = req.user;
    if (!user || user.role !== 'SUPER_ADMIN' || state.recorded) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    const path = pathOf(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body as object) : [];
    void (async () => {
      try {
        await adminAuditService.record({
          actorUserId: user.id,
          tenantId: await tenantForPath(path),
          action: ADMIN_AUDIT_ACTIONS.API_WRITE,
          details: { method: req.method, path, status: res.statusCode, fields: body },
        });
      } catch (err) {
        console.error('[admin audit] could not record a super admin write:', err);
        reportError(err);
      }
    })();
  });
};
