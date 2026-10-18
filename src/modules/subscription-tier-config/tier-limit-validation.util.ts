import { optionalWholeNumber } from '../../shared/utils/whole-number.util.js';
import { HttpError } from '../../shared/errors/http-error.js';

// The four tier limits a SUPER_ADMIN edits on the Subscription Tiers page,
// with the labels that page shows. null means unlimited (STEERING.md "Tier
// enforcement"), so null — or a blank string — is a valid, meaningful value
// here, not a missing one, and is stored as null. Anything else must be a
// whole number of 0 or more: 422 otherwise, with the frontend's own words.
// A decimal used to reach Prisma's Int columns as a generic 500.
// maxMemoryHubBytesPerEvent, in bytes, is a BIGINT column (above 2 GB is
// allowed) and must also be a safe integer: past 2^53 a JSON number no
// longer holds whole bytes exactly, and past the column's range Prisma
// refuses it with a 500.
export const TIER_LIMIT_LABELS = {
  maxEvents: 'Max events',
  maxGuestsPerEvent: 'Max guests / event',
  maxSmsPerMonth: 'Max SMS / month',
  maxVendorSpaces: 'Max vendor spaces',
  maxMemoryHubBytesPerEvent: 'Memory Hub storage per event (bytes)',
} as const;

export type TierLimitField = keyof typeof TIER_LIMIT_LABELS;

export const normalizeTierLimit = (value: unknown, field: TierLimitField): number | null => {
  const message = `Enter a whole number of 0 or more for ${TIER_LIMIT_LABELS[field]}, or leave it blank for unlimited.`;
  const limit = optionalWholeNumber(value, message);
  if (limit !== null && !Number.isSafeInteger(limit)) throw new HttpError(422, message);
  return limit;
};

// Validates and normalises every tier limit present in a create/update
// body. Omitted (undefined) means "not in this PUT" and stays omitted.
export const normalizeTierLimits = <T extends Partial<Record<TierLimitField, unknown>>>(data: T): T => {
  const out = { ...data };
  for (const field of Object.keys(TIER_LIMIT_LABELS) as TierLimitField[]) {
    if (data[field] !== undefined) {
      (out as Record<TierLimitField, unknown>)[field] = normalizeTierLimit(data[field], field);
    }
  }
  return out;
};
