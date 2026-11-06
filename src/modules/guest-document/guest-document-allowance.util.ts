import { tenantRepository } from '../tenant/tenant.repository.js';
import { subscriptionTierConfigRepository, type TierConfigRow } from '../subscription-tier-config/subscription-tier-config.repository.js';
import { resolveEventEntitlement, type EntitlementDerivableEvent } from '../event-pass/event-entitlement.util.js';
import { GUEST_DOCUMENT_CEILING_BYTES } from '../upload/upload-constants.js';
import { HttpError } from '../../shared/errors/http-error.js';
import { DOCUMENT_ERROR_CODES } from './guest-document.types.js';

// ─────────────────────────────────────────
//  GUESTS' DOCUMENTS: THEIR OWN ALLOWANCE (STEERING "Storage")
//
//  Documents never count towards the Memory Hub's storage. Each event has
//  its own document allowance, from its plan (the event's entitlement, so
//  an Event Pass counts, as for every event-scoped limit):
//  - maxDocumentBytesPerEvent: every kept document of the event together
//    (null = unlimited). An upload that would go over it is refused under
//    the event's row lock (guest-document.service.ts), 403
//    DOCUMENT_STORAGE_FULL, in words a guest can be shown.
//  - maxDocumentBytesPerFile: one document (null = the ceiling). Over it:
//    413 DOCUMENT_TOO_LARGE, naming the limit.
//  GUEST_DOCUMENT_CEILING_BYTES is the fixed safety ceiling above both: what
//  the upload route reads at most, and the most a plan may allow.
//
//  A plan with no config row: unlimited per event, the ceiling per document
//  (null means unlimited, as for every other limit). resolvePlanSettings
//  reports exactly these (documentLimitsFromConfig).
// ─────────────────────────────────────────

export interface DocumentLimits {
  maxBytesPerEvent: number | null;
  maxBytesPerDocument: number;
}

export const documentLimitsFromConfig = (
  config: Pick<TierConfigRow, 'maxDocumentBytesPerEvent' | 'maxDocumentBytesPerFile'> | null
): DocumentLimits => ({
  maxBytesPerEvent: config?.maxDocumentBytesPerEvent ?? null,
  maxBytesPerDocument: Math.min(config?.maxDocumentBytesPerFile ?? GUEST_DOCUMENT_CEILING_BYTES, GUEST_DOCUMENT_CEILING_BYTES),
});

export const resolveDocumentLimits = async (event: EntitlementDerivableEvent): Promise<DocumentLimits> => {
  const tenant = await tenantRepository.findById(event.tenantId);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  return documentLimitsFromConfig(await subscriptionTierConfigRepository.findByTier(resolveEventEntitlement(tenant, event)));
};

// "5 MB", "2.5 MB": a limit as a guest reads it.
export const formatMegabytes = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : Math.round(mb * 10) / 10} MB`;
};

export const documentTooLargeMessage = (maxBytes: number): string =>
  `This file is larger than ${formatMegabytes(maxBytes)}. Choose a smaller file.`;

export const documentTooLarge = (maxBytes: number): HttpError =>
  new HttpError(413, documentTooLargeMessage(maxBytes), DOCUMENT_ERROR_CODES.TOO_LARGE);

// Guest-safe: no plan, no figure, nothing about other guests' files.
export const DOCUMENT_STORAGE_FULL_MESSAGE = "This event can't take any more files right now. Please contact the organiser.";

export const documentStorageFull = (): HttpError =>
  new HttpError(403, DOCUMENT_STORAGE_FULL_MESSAGE, DOCUMENT_ERROR_CODES.STORAGE_FULL);

// The organiser's warning: shown once usage passes this share of the allowance.
export const DOCUMENT_STORAGE_WARNING_RATIO = 0.8;

export interface DocumentStorageView {
  usedBytes: number;
  limitBytes: number | null; // null = unlimited
  // Over 80% of the allowance used.
  nearLimit: boolean;
}

export const toDocumentStorageView = (usedBytes: number, limitBytes: number | null): DocumentStorageView => ({
  usedBytes,
  limitBytes,
  nearLimit: limitBytes !== null && usedBytes > limitBytes * DOCUMENT_STORAGE_WARNING_RATIO,
});
