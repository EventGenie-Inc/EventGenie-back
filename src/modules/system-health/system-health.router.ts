import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { skipServerErrorReport } from '../../shared/monitoring/error-reporting.js';
import { parseSystemErrorFilters, systemHealthService } from './system-health.service.js';

const router = Router();

// Platform operations: SUPER_ADMIN only, and a 404 for everyone else.
router.use(authenticate, requireSuperAdminHidden);

// GET /api/admin/system/errors?environment=&project=backend|frontend&status=unresolved|resolved|ignored
// 200 { status: 'ok', data: { health, filters, issues, fetchedAt } }
// 503 { status: 'error', message, code: SENTRY_NOT_CONFIGURED | SENTRY_UNAVAILABLE, data: { health } }
// Health comes with the 503 too: it matters most when something is wrong.
router.get('/errors', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = parseSystemErrorFilters(req.query as Record<string, unknown>);
    const [health, errors] = await Promise.all([
      systemHealthService.getHealth(),
      systemHealthService.getErrors(filters),
    ]);
    if (!errors.ok) {
      skipServerErrorReport(res);
      res.status(503).json({ status: 'error', message: errors.message, code: errors.code, data: { health } });
      return;
    }
    res.status(200).json({ status: 'ok', data: { health, filters, ...errors.list } });
  } catch (err) { next(err); }
});

export default router;
