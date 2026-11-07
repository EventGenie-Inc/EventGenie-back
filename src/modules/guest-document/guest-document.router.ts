import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireFeature } from '../../shared/middleware/feature.middleware.js';
import { requireEventAdminHidden } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { GUEST_DOCUMENT_CEILING_BYTES } from '../upload/upload-constants.js';
import { DOCUMENT_ERROR_CODES } from './guest-document.types.js';
import { guestDocumentOrganiserService } from './guest-document-organiser.service.js';

// ─────────────────────────────────────────
//  The organiser's list of an event's documents and link to one:
//  GET /api/events/:eventId/documents
//  GET /api/events/:eventId/documents/:documentId/link
//  Both read-only, and open for an archived event too: its documents are
//  kept, downloadable, for 30 days (media-retention.service.ts).
//
//  Behind documentFields; event admins only, and anyone else (a vendor, or
//  every tenant while the flag is off) gets the global 404, never a 403.
//  The guests' upload routes live with the rest of their flows:
//  POST /api/rsvp/documents (rsvp.router.ts) and
//  POST /api/public-events/:shareToken/documents (event-public.router.ts),
//  both through receiveDocument below.
// ─────────────────────────────────────────

const router = Router({ mergeParams: true });
router.use(authenticate, requireFeature('documentFields'), requireEventAdminHidden);

// Every kept document of the event, live or archived (read-only).
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const list = await guestDocumentOrganiserService.list(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.status(200).json({ status: 'ok', data: list });
  } catch (err) { next(err); }
});

router.get('/:documentId/link', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const link = await guestDocumentOrganiserService.getLink(
      req.params['eventId'] as string,
      req.params['documentId'] as string,
      auth.user.role,
      auth.user.tenantId
    );
    res.status(200).json({ status: 'ok', data: link });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────
//  RECEIVING A GUEST'S FILE (multipart, field `file`)
//
//  Held in memory, never written to disk, and at most
//  GUEST_DOCUMENT_CEILING_BYTES, the fixed safety ceiling: one byte more is
//  413 DOCUMENT_TOO_LARGE before the rest is read. The plan's own size per
//  document, below it, is checked by the service. One file, a few short text fields (token,
//  rsvpFieldId). File names are read as UTF-8 (multer's default is
//  latin1, which garbles any accent), and never logged.
// ─────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: GUEST_DOCUMENT_CEILING_BYTES, files: 1, fields: 5, fieldSize: 1024 },
});

export const receiveDocument = (req: Request, res: Response, next: NextFunction): void => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(new HttpError(413, 'This file is too large. Choose a smaller file.', DOCUMENT_ERROR_CODES.TOO_LARGE));
      return;
    }
    // Two files, an unexpected field, an oversized text field: a malformed
    // request, never a 500. Multer's own words never name the file.
    if (err instanceof multer.MulterError) {
      next(new HttpError(400, 'Upload one file at a time. Please refresh the page and try again.'));
      return;
    }
    if (err) { next(err); return; }
    next();
  });
};

export default router;
