import { Router } from 'express';
import multer from 'multer';
import { guestService } from './guest.service.js';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireEventAdmin } from '../../shared/middleware/role.middleware.js';
import {} from '../../shared/types/common.types.js';
import { HttpError } from '../../shared/errors/http-error.js';
const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES },
});
const router = Router({ mergeParams: true });
router.use(authenticate, requireEventAdmin);
router.get('/', async (req, res, next) => {
    try {
        const auth = req;
        const includeArchived = req.query['includeArchived'] === 'true';
        const guests = await guestService.getAllForEvent(req.params['eventId'], auth.user.role, auth.user.tenantId, includeArchived);
        res.status(200).json({ status: 'ok', data: guests });
    }
    catch (err) {
        next(err);
    }
});
router.post('/', async (req, res, next) => {
    try {
        const auth = req;
        const guest = await guestService.create(req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId, req.body);
        res.status(201).json({ status: 'ok', data: guest });
    }
    catch (err) {
        next(err);
    }
});
router.get('/import-template', async (req, res, next) => {
    try {
        const auth = req;
        const { buffer, filename } = await guestService.getImportTemplate(req.params['eventId'], auth.user.role, auth.user.tenantId);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.status(200).send(buffer);
    }
    catch (err) {
        next(err);
    }
});
router.post('/import', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            next(new HttpError(413, `File exceeds the maximum upload size of ${MAX_IMPORT_FILE_SIZE_BYTES / (1024 * 1024)}MB`));
            return;
        }
        if (err) {
            next(err);
            return;
        }
        next();
    });
}, async (req, res, next) => {
    try {
        const auth = req;
        if (!req.file)
            throw new HttpError(400, 'No file uploaded');
        const result = await guestService.importGuests(req.params['eventId'], auth.user.id, auth.user.role, auth.user.tenantId, { buffer: req.file.buffer, originalname: req.file.originalname, mimetype: req.file.mimetype });
        res.status(200).json({ status: 'ok', data: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
//# sourceMappingURL=guest-event.router.js.map