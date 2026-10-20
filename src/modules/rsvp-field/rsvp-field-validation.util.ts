import { type RsvpFieldType } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';

const FIELD_TYPES: readonly RsvpFieldType[] = ['TEXT', 'NUMBER', 'EMAIL', 'PHONE', 'DROPDOWN', 'CHECKBOX', 'DATE'];

// A custom RSVP question needs the question itself (the wizard marks the
// label required) and a known answer type. Shared by the rsvp-field
// endpoints and the wizard's materialize path. 422 — a blank label used to
// be saved, and an unknown type reached Prisma as a generic 500.
export const requireFieldLabel = (label: unknown): string => {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed) throw new HttpError(422, 'Each additional field needs a label: the question your guests will see.');
  return trimmed;
};

export const requireFieldType = (fieldType: unknown, label: string): RsvpFieldType => {
  if (typeof fieldType !== 'string' || !FIELD_TYPES.includes(fieldType as RsvpFieldType)) {
    throw new HttpError(422, `Choose an answer type for '${label}'.`);
  }
  return fieldType as RsvpFieldType;
};

export interface RsvpFieldInput {
  label?: unknown;
  fieldType?: unknown;
  options?: unknown;
}

// The label and answer type of a NEW question (POST .../rsvp-fields and the
// full event update), and of a change to a saved one, omitted fields kept.
export const resolveNewField = (data: RsvpFieldInput) => {
  const label = requireFieldLabel(data.label);
  const fieldType = requireFieldType(data.fieldType, label);
  assertValidFieldOptions(data.options, label);
  return { label, fieldType };
};

export const resolveFieldChanges = (data: RsvpFieldInput, existing: { label: string }) => {
  const label = data.label !== undefined ? requireFieldLabel(data.label) : undefined;
  const fieldType = data.fieldType !== undefined ? requireFieldType(data.fieldType, label ?? existing.label) : undefined;
  assertValidFieldOptions(data.options, label ?? existing.label);
  return {
    ...(label !== undefined && { label }),
    ...(fieldType !== undefined && { fieldType }),
  };
};

// A question's choices (`options`): null or left out, or a JSON-encoded
// list of text choices — what the frontend sends (event-rsvp-fields.service
// stringifies it) and what the RSVP page reads back (it shows nothing for
// anything else). Anything else is 422 RSVP_FIELD_OPTIONS_INVALID: a
// non-string used to reach Prisma's String column as a 500. POST/PUT
// .../rsvp-fields and the full event update.
export const RSVP_FIELD_OPTIONS_INVALID = 'RSVP_FIELD_OPTIONS_INVALID';

export const assertValidFieldOptions = (options: unknown, label: string): void => {
  if (options === undefined || options === null) return;
  let parsed: unknown = null;
  if (typeof options === 'string') {
    try {
      parsed = JSON.parse(options);
    } catch {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed) || !parsed.every((choice) => typeof choice === 'string')) {
    throw new HttpError(422, `The choices for '${label}' must be a list of text options.`, RSVP_FIELD_OPTIONS_INVALID);
  }
};

// The wizard's draft carries a question's choices as a list (the frontend's
// draft model), not as the JSON string the other paths take: a list is
// encoded first, a string taken as it is, and either is held to the same
// rule and code as POST/PUT .../rsvp-fields (assertValidFieldOptions).
// Returns what materialize stores: the JSON string, or null for none.
export const resolveDraftFieldOptions = (options: unknown, label: string): string | null => {
  if (options === undefined || options === null) return null;
  const encoded = Array.isArray(options) ? JSON.stringify(options) : options;
  assertValidFieldOptions(encoded, label);
  return encoded as string;
};
