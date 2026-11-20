import { type EventGrantDeliveryStatus, type SubscriptionTier } from '@prisma/client';

// ─────────────────────────────────────────
//  GRANTED EVENTS (STEERING "Custom tiers", granted events; behind
//  customTiers)
// ─────────────────────────────────────────

// POST /api/admin/event-grants — arrives as unknown JSON, checked by
// event-grant.service.ts.
export interface CreateEventGrantInput {
  // A template: an event of the internal e-velope organisation.
  sourceEventId?: unknown;
  // The copy's name, and first date (YYYY-MM-DD; the template's own first
  // date when left out).
  name?: unknown;
  firstDate?: unknown;
  // The copy's feature set: exactly one of a standard tier or an active
  // custom tier.
  grantedTier?: unknown;
  grantedCustomTierId?: unknown;
  // Who gets it: chosen tenants, and/or every tenant created before
  // allTenantsUntil (existing ones and new sign-ups).
  tenantIds?: unknown;
  toAllTenants?: unknown;
  allTenantsUntil?: unknown;
}

export interface EventGrantRecipientView {
  tenantId: string;
  tenantName: string;
  status: EventGrantDeliveryStatus;
  eventId: string | null;
  failureReason: string | null;
  // A DELIVERED copy's caveat, for the super admin: its host name couldn't be
  // the organisation's name (blank, or too long), so it has none yet. Null
  // otherwise.
  notice: string | null;
  deliveredAt: Date | null;
}

export interface EventGrantView {
  id: string;
  sourceEventId: string;
  sourceEventName: string;
  name: string;
  firstDate: Date | null;
  grantedTier: SubscriptionTier | null;
  grantedCustomTier: { id: string; name: string } | null;
  toAllTenants: boolean;
  allTenantsUntil: Date | null;
  createdByUserId: string;
  createdAt: Date;
  recipients: EventGrantRecipientView[];
}

export const EVENT_GRANT_ERROR_CODES = {
  NOT_FOUND: 'EVENT_GRANT_NOT_FOUND',
  // sourceEventId isn't one of the internal organisation's events.
  TEMPLATE_NOT_FOUND: 'EVENT_GRANT_TEMPLATE_NOT_FOUND',
  // A granted event carries no guests and sells no tickets.
  TEMPLATE_PAID: 'EVENT_GRANT_TEMPLATE_PAID',
  // Neither or both of grantedTier / grantedCustomTierId.
  PLAN_REQUIRED: 'EVENT_GRANT_PLAN_REQUIRED',
  // No tenantIds and not toAllTenants; or toAllTenants without a future
  // allTenantsUntil.
  RECIPIENTS_REQUIRED: 'EVENT_GRANT_RECIPIENTS_REQUIRED',
  // A tenantIds entry that is no tenant (or the internal organisation).
  TENANT_UNKNOWN: 'EVENT_GRANT_TENANT_UNKNOWN',
  DATE_INVALID: 'EVENT_GRANT_DATE_INVALID',
} as const;

export const MAX_TENANTS_PER_REQUEST = 200;
