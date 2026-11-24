import { type CustomTier, type CustomTierRequestStatus } from '@prisma/client';

// ─────────────────────────────────────────
//  CUSTOM TIERS (STEERING "Custom tiers")
// ─────────────────────────────────────────

// A CustomTier row as the code sees it: the two BIGINT byte limits as plain
// numbers, like subscription-tier-config.repository.ts's TierConfigRow (a
// bigint can't be written to JSON or compared with a byte count).
export type CustomTierRow = Omit<CustomTier, 'maxMemoryHubBytesPerEvent' | 'maxDocumentBytesPerEvent'> & {
  maxMemoryHubBytesPerEvent: number | null;
  maxDocumentBytesPerEvent: number | null;
};

// What a super admin sends to create or edit one. Limits: a whole number of
// 0 or more, or null for unlimited (tier-limit-validation.util.ts, as for the
// standard tiers); switches: true or false. On create, a setting left out
// takes the column's default (limits unlimited, switches off, email on).
export interface CustomTierInput {
  name?: unknown;
  description?: unknown;
  maxEvents?: unknown;
  maxGuestsPerEvent?: unknown;
  maxSmsPerMonth?: unknown;
  maxVendorSpaces?: unknown;
  maxMemoryHubBytesPerEvent?: unknown;
  maxDocumentBytesPerEvent?: unknown;
  maxDocumentBytesPerFile?: unknown;
  emailEnabled?: unknown;
  smsEnabled?: unknown;
  vendorMarketplace?: unknown;
  memoryHubEnabled?: unknown;
  dragDropBuilder?: unknown;
  guestExportEnabled?: unknown;
  publicEventsEnabled?: unknown;
  paidTicketingEnabled?: unknown;
  customRsvpFieldsEnabled?: unknown;
  vendorPriorityPlacement?: unknown;
  qrCheckInEnabled?: unknown;
  invitationDesignsEnabled?: unknown;
  // false retires it, true brings it back. Never deleted.
  isActive?: unknown;
}

// The super admin's list: the tier and how many tenants are on it now
// (assigned and before their end date).
export type CustomTierView = CustomTierRow & { tenantCount: number };

// Assigning a tenant: the tier, an optional end date (ISO; null or left out =
// no end), and the super admin's word that the tenant's Paystack
// subscription is cancelled, needed only while it has an active one.
export interface AssignCustomTierInput {
  customTierId?: unknown;
  endsAt?: unknown;
  confirmSubscriptionCancelled?: unknown;
}

// A tenant's current custom tier, as /me and /api/subscriptions show it.
export interface TenantCustomTierView {
  id: string;
  name: string;
  description: string | null;
  endsAt: Date | null;
}

export const CUSTOM_TIER_ERROR_CODES = {
  NOT_FOUND: 'CUSTOM_TIER_NOT_FOUND',
  NAME_REQUIRED: 'CUSTOM_TIER_NAME_REQUIRED',
  NAME_TAKEN: 'CUSTOM_TIER_NAME_TAKEN',
  // A retired tier can't be assigned, to a tenant or a grant.
  RETIRED: 'CUSTOM_TIER_RETIRED',
  END_DATE_INVALID: 'CUSTOM_TIER_END_DATE_INVALID',
  // The tenant has an active Paystack subscription: cancel it first, then
  // assign with confirmSubscriptionCancelled: true.
  ACTIVE_SUBSCRIPTION: 'CUSTOM_TIER_ACTIVE_SUBSCRIPTION',
  INTERNAL_TENANT: 'CUSTOM_TIER_INTERNAL_TENANT',
} as const;

// ── Requests ──

export interface CustomTierRequestInput {
  needs?: unknown;
  expectedEvents?: unknown;
  expectedGuests?: unknown;
  contactName?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  // ISO 3166 two-letter code for a number written without a country code;
  // South Africa when left out (the shared phone rules).
  contactPhoneCountry?: unknown;
}

export interface CustomTierRequestUpdateInput {
  status?: unknown;
  note?: unknown;
}

export const CUSTOM_TIER_REQUEST_STATUSES: readonly CustomTierRequestStatus[] = ['NEW', 'IN_DISCUSSION', 'ACCEPTED', 'DECLINED'];

export const CUSTOM_TIER_REQUEST_ERROR_CODES = {
  NOT_FOUND: 'CUSTOM_TIER_REQUEST_NOT_FOUND',
  STATUS_INVALID: 'CUSTOM_TIER_REQUEST_STATUS_INVALID',
  NOTHING_TO_UPDATE: 'CUSTOM_TIER_REQUEST_NOTHING_TO_UPDATE',
} as const;

export const NEEDS_MAX_LENGTH = 2000;
export const NOTE_MAX_LENGTH = 1000;
