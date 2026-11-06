import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { memoryHubGuestUploadIpLimiter, memoryHubGuestUploadLimiter, storageReleaseLimiter } from '../../shared/middleware/rate-limit.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { reportError } from '../../shared/monitoring/error-reporting.js';
import { isNotificationSignatureValid } from '../../shared/cloudinary/cloudinary-notification.util.js';
import { inviteRepository } from '../invite/invite.repository.js';
import { storedFileService } from './stored-file.service.js';
import { storageDeletionWorker } from './storage-deletion.worker.js';
import { STORAGE_ERROR_CODES } from './stored-file.types.js';

const router = Router();

// ─────────────────────────────────────────
//  POST /api/storage/files/release — an organiser drops an upload they
//  never saved (picked another cover, cancelled a Memory Hub upload).
//  Body { publicId } (the full public id the upload reported). Only their
//  own, only while unsaved; anything else is 404 UPLOAD_NOT_FOUND. The
//  file is deleted at once (a failure is retried by the worker).
//  200 { status: 'ok', data: { released: true } }; releasing again is the
//  same 200.
// ─────────────────────────────────────────
router.post('/files/release', authenticate, requireEventAdmin, storageReleaseLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const fileId = await storedFileService.release({ userId: auth.user.id }, (req.body as { publicId?: unknown })?.publicId);
    await storageDeletionWorker.deleteNow([fileId]);
    res.status(200).json({ status: 'ok', data: { released: true } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  POST /api/storage/files/guest-release — the same for a guest's own
//  unsaved Memory Hub upload, authenticated by their invite token.
//  Body { token, publicId }. Rate limited like a guest upload.
// ─────────────────────────────────────────
router.post('/files/guest-release', memoryHubGuestUploadIpLimiter, memoryHubGuestUploadLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { token?: unknown; publicId?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new HttpError(400, 'token is required');
    const invite = await inviteRepository.findByToken(body.token);
    if (!invite) throw new HttpError(404, "This upload couldn't be found.", STORAGE_ERROR_CODES.UPLOAD_NOT_FOUND);
    const fileId = await storedFileService.release({ inviteId: invite.id }, body.publicId);
    await storageDeletionWorker.deleteNow([fileId]);
    res.status(200).json({ status: 'ok', data: { released: true } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  POST /api/storage/cloudinary/notifications — Cloudinary's upload
//  notification (notification_url, signed into each upload when
//  STORAGE_NOTIFICATION_URL is set). Public: the signature over the raw
//  body (X-Cld-Signature, X-Cld-Timestamp) IS the authentication. Invalid:
//  401 and nothing read or written. Valid: 200 whatever it said, so
//  Cloudinary doesn't retry a notification there's nothing to do with.
// ─────────────────────────────────────────
router.post('/cloudinary/notifications', async (req: Request, res: Response) => {
  const rawBody = req.rawBody?.toString('utf8');
  if (!rawBody || !isNotificationSignatureValid(rawBody, req.headers['x-cld-signature'], req.headers['x-cld-timestamp'])) {
    console.warn('[storage] Cloudinary notification rejected: invalid or missing signature');
    res.status(401).json({ status: 'error', message: 'Invalid signature' });
    return;
  }
  try {
    const outcome = await storedFileService.handleUploadNotification(req.body);
    res.status(200).json({ status: 'ok', outcome });
  } catch (err) {
    // A 500 makes Cloudinary retry (3, 6 and 9 minutes later); the save's
    // own explicit call covers the size in the meantime.
    reportError(err);
    res.status(500).json({ status: 'error', message: 'Could not record the notification' });
  }
});

export default router;
