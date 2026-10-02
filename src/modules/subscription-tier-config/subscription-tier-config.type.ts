import { type SubscriptionTier } from '@prisma/client';

export interface CreateSubscriptionTierConfigDto {
  tier: SubscriptionTier;
  maxEvents?: number;
  maxGuestsPerEvent?: number;
  maxSmsPerMonth?: number;
  // number | null (not just number) — null is a meaningful value here
  // (unlimited, STEERING.md "Tier enforcement"), not a missing one, and
  // a SUPER_ADMIN must be able to send it explicitly to set a tier back
  // to unlimited. Validated by tier-limit-validation.util.ts's
  // assertValidTierLimit. The sibling max* fields below have the same
  // "really nullable" runtime shape (see subscription-tier-config.
  // repository.ts's `?? null` writes) but are left as `number` here,
  // unchanged — flagged, not fixed, out of this task's scope.
  maxVendorSpaces?: number | null;
  maxMemoryHubBytesPerEvent?: number;
  emailEnabled: boolean;
  smsEnabled: boolean;
  vendorMarketplace: boolean;
  memoryHubEnabled: boolean;
  dragDropBuilder: boolean;
  guestExportEnabled: boolean;
}

export interface UpdateSubscriptionTierConfigDto {
  maxEvents?: number;
  maxGuestsPerEvent?: number;
  maxSmsPerMonth?: number;
  // See CreateSubscriptionTierConfigDto's identical comment.
  maxVendorSpaces?: number | null;
  maxMemoryHubBytesPerEvent?: number;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  vendorMarketplace?: boolean;
  memoryHubEnabled?: boolean;
  dragDropBuilder?: boolean;
  guestExportEnabled?: boolean;
  isAvailable?: boolean;
}