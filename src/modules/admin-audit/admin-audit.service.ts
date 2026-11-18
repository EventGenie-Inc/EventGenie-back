import { type Prisma } from '@prisma/client';
import prisma from '../../shared/prisma/prisma.client.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { adminAuditRepository } from './admin-audit.repository.js';
import { markAuditRecorded } from './admin-audit.context.js';
import {
  AUDIT_LOG_DEFAULT_LIMIT,
  AUDIT_LOG_MAX_LIMIT,
  type AdminAuditEntryView,
  type AdminAuditInput,
} from './admin-audit.types.js';

type Db = Prisma.TransactionClient | typeof prisma;

// Dates and other values to plain JSON (a Date as its ISO string).
const toJson = (details: Record<string, unknown>): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue;

const parseLimit = (raw: unknown): number => {
  if (raw === undefined) return AUDIT_LOG_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a whole number of 1 or more.');
  return Math.min(n, AUDIT_LOG_MAX_LIMIT);
};

const parseBefore = (raw: unknown): Date | null => {
  if (raw === undefined) return null;
  const d = typeof raw === 'string' ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) throw new HttpError(400, 'before must be a date and time.');
  return d;
};

export const adminAuditService = {
  // Written by the service that acts, in its own transaction where it has
  // one (`db`), so the change and its record commit together.
  record: async (input: AdminAuditInput, db: Db = prisma): Promise<void> => {
    const actorEmail = await adminAuditRepository.findActorEmail(input.actorUserId, db);
    await adminAuditRepository.create(
      { actorUserId: input.actorUserId, actorEmail, tenantId: input.tenantId, action: input.action, details: toJson(input.details) },
      db
    );
    markAuditRecorded();
  },

  // GET /api/admin/tenants/:tenantId/audit-log: one tenant's entries, newest
  // first, `limit` at a time (default 100, at most 500), `before` an entry's
  // createdAt for the next page.
  listForTenant: async (tenantId: string, query: { limit?: unknown; before?: unknown }): Promise<AdminAuditEntryView[]> => {
    if (!(await adminAuditRepository.tenantExists(tenantId))) throw new HttpError(404, 'Tenant not found');
    return adminAuditRepository.list({ tenantId }, parseLimit(query.limit), parseBefore(query.before));
  },

  // GET /api/admin/audit-log: every entry (scope=platform: only the
  // platform-wide ones, no tenant).
  list: async (query: { limit?: unknown; before?: unknown; scope?: unknown }): Promise<AdminAuditEntryView[]> => {
    if (query.scope !== undefined && query.scope !== 'platform') throw new HttpError(400, 'scope must be platform, or left out.');
    return adminAuditRepository.list(query.scope === 'platform' ? { tenantId: null } : {}, parseLimit(query.limit), parseBefore(query.before));
  },
};
