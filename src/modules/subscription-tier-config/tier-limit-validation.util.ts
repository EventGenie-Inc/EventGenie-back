import { HttpError } from '../../shared/errors/http-error.js';

// Validates a tier's numeric ceiling field (maxVendorSpaces, and — by the
// same convention — every other max* column on SubscriptionTierConfig):
// null means unlimited (STEERING.md "Tier enforcement"), so null is a
// valid, meaningful value here, not a missing one. undefined ("omitted
// from this PUT") is the caller's concern, not this function's — callers
// only invoke this when the field is present in the request body.
//
// Scoped to maxVendorSpaces for now (Vendor Limit batch) — the sibling
// max* fields (maxEvents, maxGuestsPerEvent, maxSmsPerMonth,
// maxMemoryHubBytesPerEvent) have no equivalent validation on the tier
// update endpoint today and are not touched here; see the batch report.
export const assertValidTierLimit = (value: number | null, fieldLabel: string): void => {
  if (value === null) return;

  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(400, `'${fieldLabel}' must be a non-negative whole number, or null for unlimited.`);
  }
};
