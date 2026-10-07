import { Router, type Request, type Response, type NextFunction } from 'express';
import { PlatformRole } from '@prisma/client';
import { userService } from './user.service.js';
import { userInviteService } from './user-invite.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireTenantAdmin, requireRole } from '../../shared/middleware/role.middleware.js';
import { teamInviteSendLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';

const router = Router();
router.use(authenticate, requireFeature('teamMembers'), requireTenantAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const users = await userService.getAll(auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: users });
  } catch (err) { next(err); }
});

// ── Team invitations (Team Members batch) ──
// TENANT_ADMIN only (stacked on the router-level gate): an invitation is
// always into the admin's own tenant. Declared before '/:id' so 'invites'
// is never read as a user id.
const requireTenantAdminOnly = requireRole(PlatformRole.TENANT_ADMIN);

router.get('/invites', requireTenantAdminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const invites = await userInviteService.list(auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: invites });
  } catch (err) { next(err); }
});

router.post('/invites', requireTenantAdminOnly, teamInviteSendLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await userInviteService.create(auth.user.tenantId, auth.user.id, req.body ?? {});
    res.status(201).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/invites/:inviteId/resend', requireTenantAdminOnly, teamInviteSendLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const result = await userInviteService.resend(auth.user.tenantId, auth.user.id, req.params['inviteId'] as string);
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

router.post('/invites/:inviteId/revoke', requireTenantAdminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const invite = await userInviteService.revoke(auth.user.tenantId, req.params['inviteId'] as string);
    res.status(200).json({ status: 'ok', data: invite });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const user = await userService.getById(req.params['id'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const user = await userService.create(auth.user.role, auth.user.id, auth.user.tenantId, req.body);
    res.status(201).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const user = await userService.update(req.params['id'] as string, auth.user.role, auth.user.tenantId, auth.user.id, req.body);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

// Event assignments (the assignment lock): the member's whole list.
router.put('/:id/assignments', requireTenantAdminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const member = await userService.setAssignments(
      req.params['id'] as string, auth.user.role, auth.user.tenantId, auth.user.id, req.body ?? {}
    );
    res.status(200).json({ status: 'ok', data: member });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    await userService.archive(req.params['id'] as string, auth.user.role, auth.user.tenantId, auth.user.id);
    res.status(200).json({ status: 'ok', message: 'User archived' });
  } catch (err) { next(err); }
});

// Suspend / reactivate. Was SUPER_ADMIN only; a TENANT_ADMIN may now
// suspend and reactivate members of their own tenant (Team Members batch).
// Tenant-scoped through userService.getById (another tenant's user is a
// 404); nobody can suspend themselves, and the last active TENANT_ADMIN
// can't be suspended (userService.archive).
router.post('/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const user = await userService.archive(req.params['id'] as string, auth.user.role, auth.user.tenantId, auth.user.id);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

router.post('/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const user = await userService.reactivate(req.params['id'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: user });
  } catch (err) { next(err); }
});

export default router;