import { Router, type Request, type Response, type NextFunction } from 'express';
import { userInviteService } from './user-invite.service.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { teamInviteTokenLimiter, teamInviteIpLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { HttpError } from '../../shared/errors/http-error.js';

// ─────────────────────────────────────────
//  /api/team-invites — PUBLIC (no authenticate): the invitee has no
//  account yet. The invite token in the body is the credential; accept
//  also takes the new account's Firebase ID token. Behind the
//  teamMembers flag (off = the global 404 for everyone, as on any public
//  route). Rate-limited per token hash and per IP (failures only).
// ─────────────────────────────────────────

const router = Router();
router.use(requireFeature('teamMembers'), teamInviteIpLimiter, teamInviteTokenLimiter);

// POST /api/team-invites/lookup  { token } → { email, companyName, role, expiresAt }
router.post('/lookup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invite = await userInviteService.lookup(req.body?.token);
    res.status(200).json({ status: 'ok', data: invite });
  } catch (err) { next(err); }
});

// POST /api/team-invites/accept  Authorization: Bearer <Firebase ID token>
// { token, username } → { user, tenant }
router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    const firebaseToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
    if (!firebaseToken) throw new HttpError(401, 'Missing or malformed Authorization header');
    const result = await userInviteService.accept(firebaseToken, req.body ?? {});
    res.status(201).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
