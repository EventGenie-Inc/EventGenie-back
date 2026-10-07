import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { bindRequestViewer } from '../../shared/context/request-viewer.context.js';
import { guestService } from './guest.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import { type AuthenticatedRequest } from '../../shared/types/common.types.js';
import { HttpError } from '../../shared/errors/http-error.js';

const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES },
});

const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const includeArchived = req.query['includeArchived'] === 'true';
    const guests = await guestService.getAllForEvent(req.params['eventId'] as string, auth.user.role, auth.user.tenantId, includeArchived);
    res.status(200).json({ status: 'ok', data: guests });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const guest = await guestService.create(req.params['eventId'] as string, auth.user.id, auth.user.role, auth.user.tenantId, req.body);
    res.status(201).json({ status: 'ok', data: guest });
  } catch (err) { next(err); }
});

router.get('/import-template', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const { buffer, filename } = await guestService.getImportTemplate(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  } catch (err) { next(err); }
});

router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    const { buffer, filename } = await guestService.exportGuests(req.params['eventId'] as string, auth.user.role, auth.user.tenantId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  } catch (err) { next(err); }
});

router.post('/import', (req: Request, res: Response, next: NextFunction) => {
  // Bound to the request viewer (request-viewer.context.ts): multer calls
  // back from a stream event, and Node doesn't guarantee the async context
  // the assignment lock reads the signed-in user from survives that. It did
  // survive in the Team Members batch's tests (the import test still passed
  // unbound), so this is insurance, not a proven fix: if the context were
  // lost, every EVENT_ADMIN's import would fail closed with a 404.
  upload.single('file')(req, res, bindRequestViewer((err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(new HttpError(413, `File exceeds the maximum upload size of ${MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024)}MB`));
      return;
    }
    if (err) { next(err); return; }
    next();
  }));
}, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = req as AuthenticatedRequest;
    if (!req.file) throw new HttpError(400, 'No file uploaded');

    const result = await guestService.importGuests(
      req.params['eventId'] as string,
      auth.user.id,
      auth.user.role,
      auth.user.tenantId,
      { buffer: req.file.buffer, originalname: req.file.originalname, mimetype: req.file.mimetype }
    );
    res.status(200).json({ status: 'ok', data: result });
  } catch (err) { next(err); }
});

export default router;
