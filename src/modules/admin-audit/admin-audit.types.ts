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
  // Starter designs (invitation-starter.service.ts), platform-wide. Details:
  // the starter's id and name, and what changed (field names, statuses,
  // files released); never the document itself.
  INVITATION_STARTER_CREATED: 'INVITATION_STARTER_CREATED',
  INVITATION_STARTER_UPDATED: 'INVITATION_STARTER_UPDATED',
  INVITATION_STARTER_PUBLISHED: 'INVITATION_STARTER_PUBLISHED',
  INVITATION_STARTER_UNPUBLISHED: 'INVITATION_STARTER_UNPUBLISHED',
  INVITATION_STARTER_RETIRED: 'INVITATION_STARTER_RETIRED',
  INVITATION_STARTER_DELETED: 'INVITATION_STARTER_DELETED',
  INVITATION_STARTER_REORDERED: 'INVITATION_STARTER_REORDERED',
  // A read, recorded because it shows guests' personal information: the
  // super admin console's guest list for one event (admin-console.service.ts),
  // one entry per view, against the event's tenant.
  EVENT_GUEST_LIST_VIEWED: 'EVENT_GUEST_LIST_VIEWED',
  // The payout account (ticket sales Round A): every step of a setup or a
  // change, by the Tenant Admin who asked for it, or by the system
  // (PAYOUT_AUDIT_SYSTEM_ACTOR) when the worker confirms, applies or gives
  // up on one. Recorded so the super admin can see who sent an
  // organisation's ticket money where, and when. Details: the change's id,
  // kind, bank, last 4 digits and dates; never the account number.
  PAYOUT_ACCOUNT_SETUP_REQUESTED: 'PAYOUT_ACCOUNT_SETUP_REQUESTED',
  PAYOUT_ACCOUNT_CHANGE_REQUESTED: 'PAYOUT_ACCOUNT_CHANGE_REQUESTED',
  PAYOUT_ACCOUNT_SUBACCOUNT_CREATED: 'PAYOUT_ACCOUNT_SUBACCOUNT_CREATED',
  PAYOUT_ACCOUNT_APPLIED: 'PAYOUT_ACCOUNT_APPLIED',
  PAYOUT_ACCOUNT_CHANGE_CANCELLED: 'PAYOUT_ACCOUNT_CHANGE_CANCELLED',
  PAYOUT_ACCOUNT_CHANGE_FAILED: 'PAYOUT_ACCOUNT_CHANGE_FAILED',
  // An unused subaccount deactivated at Paystack: a cancelled or failed
  // change's own, or the one a change replaced (details.reason).
  PAYOUT_ACCOUNT_SUBACCOUNT_DEACTIVATED: 'PAYOUT_ACCOUNT_SUBACCOUNT_DEACTIVATED',
  // Ticket sales Round B: an organiser cancelled tickets (details: the
  // event, the order, each ticket and whether it had been checked in, the
  // reason). No money moved.
  TICKETS_CANCELLED: 'TICKETS_CANCELLED',
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
