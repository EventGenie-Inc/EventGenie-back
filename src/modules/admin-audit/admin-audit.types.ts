// ─────────────────────────────────────────
//  ADMIN AUDIT LOG (STEERING "Super admin audit log")
//
//  Every super admin action that changes a tenant's account, or the
//  platform's tiers. The action names are stable strings: the frontend
//  shows a label per name, and an unknown one as it is.
// ─────────────────────────────────────────

export const ADMIN_AUDIT_ACTIONS = {
  // Tenants
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_REACTIVATED: 'TENANT_REACTIVATED',
  // Custom tiers on a tenant
  CUSTOM_TIER_ASSIGNED: 'CUSTOM_TIER_ASSIGNED',
  CUSTOM_TIER_REMOVED: 'CUSTOM_TIER_REMOVED',
  // Events
  EVENT_RESTORED: 'EVENT_RESTORED',
  EVENT_MEDIA_PURGED: 'EVENT_MEDIA_PURGED',
  EVENT_GRANTED: 'EVENT_GRANTED',
  // A grant made (platform-wide; each tenant's copy is its own EVENT_GRANTED).
  EVENT_GRANT_CREATED: 'EVENT_GRANT_CREATED',
  EVENT_TEMPLATE_CREATED: 'EVENT_TEMPLATE_CREATED',
  // Requests for a custom tier
  CUSTOM_TIER_REQUEST_UPDATED: 'CUSTOM_TIER_REQUEST_UPDATED',
  // Platform-wide (no tenant)
  CUSTOM_TIER_CREATED: 'CUSTOM_TIER_CREATED',
  CUSTOM_TIER_UPDATED: 'CUSTOM_TIER_UPDATED',
  TIER_CONFIG_CREATED: 'TIER_CONFIG_CREATED',
  TIER_CONFIG_UPDATED: 'TIER_CONFIG_UPDATED',
  TIER_AVAILABILITY_CHANGED: 'TIER_AVAILABILITY_CHANGED',
  // A read, recorded because it shows guests' personal information: the
  // super admin console's guest list for one event (admin-console.service.ts),
  // one entry per view, against the event's tenant.
  EVENT_GUEST_LIST_VIEWED: 'EVENT_GUEST_LIST_VIEWED',
  // Any other super admin write, recorded by admin-audit.middleware.ts from
  // the request itself (method, path, which fields were sent).
  API_WRITE: 'API_WRITE',
} as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[keyof typeof ADMIN_AUDIT_ACTIONS];

export interface AdminAuditInput {
  actorUserId: string;
  // The tenant whose account changed; null for a platform-wide change.
  tenantId: string | null;
  action: AdminAuditAction;
  // What changed: ids, before and after. Never a secret (a token, a card).
  details: Record<string, unknown>;
}

// GET /api/admin/tenants/:tenantId/audit-log and /api/admin/audit-log.
export interface AdminAuditEntryView {
  id: string;
  actorUserId: string;
  actorEmail: string;
  tenantId: string | null;
  action: string;
  details: unknown;
  createdAt: Date;
}

// The paging cursor: the last entry seen (its createdAt, and its id).
export interface AuditCursor {
  createdAt: Date;
  id: string | null;
}

export const AUDIT_LOG_DEFAULT_LIMIT = 100;
export const AUDIT_LOG_MAX_LIMIT = 500;
