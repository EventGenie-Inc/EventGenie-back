import { Router, type Request, type Response, type NextFunction } from 'express';
import { type LedgerEntryType, LedgerEntryType as LedgerEntryTypes } from '@prisma/client';
import { authenticate } from '../../shared/middleware/auth.middleware.js';
import { requireSuperAdminHidden } from '../../shared/middleware/role.middleware.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { paymentReconciliationService } from './payment-reconciliation.service.js';

// ─────────────────────────────────────────
//  /api/admin/payments — SUPER_ADMIN only (payments release 1). Everyone
//  else gets the global 404 (requireSuperAdminHidden), not a 403. Read-only:
//  the ledger, the mismatches, the reconciliation runs. Not behind a
//  feature flag: it is how money is checked, with payments on or off.
// ─────────────────────────────────────────
const router = Router();
router.use(authenticate, requireSuperAdminHidden);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const parseLimit = (value: unknown): number => {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new HttpError(422, `limit must be a whole number from 1 to ${MAX_LIMIT}.`, 'INVALID_LIMIT');
  }
  return n;
};

const parseDate = (value: unknown, name: string): Date | undefined => {
  if (value === undefined || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new HttpError(422, `${name} must be a date.`, 'INVALID_DATE');
  return date;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

// GET /api/admin/payments/ledger?tenantId=&eventId=&type=A,B&reference=&from=&to=&cursor=&limit=
// Newest first. `reference` matches our reference or Paystack's transaction id.
router.get('/ledger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawTypes = optionalString(req.query['type']);
    let types: LedgerEntryType[] | undefined;
    if (rawTypes) {
      const known = Object.values(LedgerEntryTypes) as string[];
      const list = rawTypes.split(',').map((t) => t.trim()).filter(Boolean);
      const unknown = list.filter((t) => !known.includes(t));
      if (unknown.length > 0) throw new HttpError(422, `Unknown ledger type: ${unknown.join(', ')}.`, 'INVALID_LEDGER_TYPE');
      types = list as LedgerEntryType[];
    }
    const tenantId = optionalString(req.query['tenantId']);
    const eventId = optionalString(req.query['eventId']);
    const reference = optionalString(req.query['reference']);
    const cursor = optionalString(req.query['cursor']);
    const from = parseDate(req.query['from'], 'from');
    const to = parseDate(req.query['to'], 'to');
    const page = await paymentReconciliationService.listLedger({
      limit: parseLimit(req.query['limit']),
      ...(tenantId && { tenantId }),
      ...(eventId && { eventId }),
      ...(reference && { reference }),
      ...(cursor && { cursor }),
      ...(types && { types }),
      ...(from && { from }),
      ...(to && { to }),
    });
    res.status(200).json({ status: 'ok', data: page });
  } catch (err) { next(err); }
});

// GET /api/admin/payments/mismatches?status=open|resolved|all&cursor=&limit=
router.get('/mismatches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = optionalString(req.query['status']) ?? 'open';
    if (status !== 'open' && status !== 'resolved' && status !== 'all') {
      throw new HttpError(422, 'status must be open, resolved or all.', 'INVALID_STATUS');
    }
    const cursor = optionalString(req.query['cursor']);
    const page = await paymentReconciliationService.listMismatches({
      status,
      limit: parseLimit(req.query['limit']),
      ...(cursor && { cursor }),
    });
    res.status(200).json({ status: 'ok', data: page });
  } catch (err) { next(err); }
});

// GET /api/admin/payments/reconciliation-runs?limit=
router.get('/reconciliation-runs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const runs = await paymentReconciliationService.listRuns(parseLimit(req.query['limit']));
    res.status(200).json({ status: 'ok', data: runs });
  } catch (err) { next(err); }
});

export default router;
