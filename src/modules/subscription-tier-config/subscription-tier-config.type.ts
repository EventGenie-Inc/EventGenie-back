import { type SubscriptionTier } from '@prisma/client';

export interface CreateSubscriptionTierConfigDto {
  tier: SubscriptionTier;
  // number | null — null is a meaningful value for all five limits
  // (unlimited, STEERING.md "Tier enforcement"), not a missing one, and a
  // SUPER_ADMIN must be able to send it explicitly to set a tier back to
  // unlimited. Validated and normalised (blank string -> null) by
  // tier-limit-validation.util.ts's normalizeTierLimits.
  maxEvents?: number | null;
  maxGuestsPerEvent?: number | null;
  maxSmsPerMonth?: number | null;
  maxVendorSpaces?: number | null;
  maxMemoryHubBytesPerEvent?: number | null;
  emailEnabled: boolean;
  smsEnabled: boolean;
  vendorMarketplace: boolean;
  memoryHubEnabled: boolean;
  dragDropBuilder: boolean;
  guestExportEnabled: boolean;
  // Free Pilot — tier-capabilities.util.ts. Optional on create: an omitted
  // one gets that tier's old in-code default.
  publicEventsEnabled?: boolean;
  paidTicketingEnabled?: boolean;
  customRsvpFieldsEnabled?: boolean;
  vendorPriorityPlacement?: boolean;
}

export interface UpdateSubscriptionTierConfigDto {
  // See CreateSubscriptionTierConfigDto's comment.
  maxEvents?: number | null;
  maxGuestsPerEvent?: number | null;
  maxSmsPerMonth?: number | null;
  maxVendorSpaces?: number | null;
  maxMemoryHubBytesPerEvent?: number | null;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  vendorMarketplace?: boolean;
  memoryHubEnabled?: boolean;
  dragDropBuilder?: boolean;
  guestExportEnabled?: boolean;
  publicEventsEnabled?: boolean;
  paidTicketingEnabled?: boolean;
  customRsvpFieldsEnabled?: boolean;
  vendorPriorityPlacement?: boolean;
  isAvailable?: boolean;
}