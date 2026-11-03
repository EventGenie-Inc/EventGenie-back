import { type RsvpFieldType } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { DOCUMENT_ERROR_CODES, DOCUMENT_FIELDS_UNAVAILABLE_MESSAGE } from '../guest-document/guest-document.types.js';
import { rsvpFieldRepository } from './rsvp-field.repository.js';

const FIELD_TYPES: readonly RsvpFieldType[] = ['TEXT', 'NUMBER', 'EMAIL', 'PHONE', 'DROPDOWN', 'CHECKBOX', 'DATE', 'DOCUMENT'];

// A custom RSVP question needs the question itself (the wizard marks the
// label required) and a known answer type. Shared by the rsvp-field
// endpoints and the wizard's materialize path. 422 — a blank label used to
// be saved, and an unknown type reached Prisma as a generic 500.
export const requireFieldLabel = (label: unknown): string => {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed) throw new HttpError(422, 'Each additional field needs a label: the question your guests will see.');
  return trimmed;
};

// `stored` is the saved question's type, when there is one. A DOCUMENT
// question is new only while documentFields is on (422
// DOCUMENT_FIELDS_UNAVAILABLE, checked on every path that saves one: the
// rsvp-field endpoints, the full update, the wizard's materialize). Only a
// change is refused: a saved DOCUMENT question re-sent as it is still
// saves, so an older event stays editable (STEERING "Feature flags").
export const requireFieldType = (fieldType: unknown, label: string, stored?: RsvpFieldType): RsvpFieldType => {
  if (typeof fieldType !== 'string' || !FIELD_TYPES.includes(fieldType as RsvpFieldType)) {
    throw new HttpError(422, `Choose an answer type for '${label}'.`);
  }
  if (fieldType === 'DOCUMENT' && stored !== 'DOCUMENT' && !isFeatureEnabled('documentFields')) {
    throw new HttpError(422, DOCUMENT_FIELDS_UNAVAILABLE_MESSAGE, DOCUMENT_ERROR_CODES.FIELDS_UNAVAILABLE);
  }
  return fieldType as RsvpFieldType;
};

// A question with answers can't become a file upload, nor stop being one:
// the answers already given (text, or references to files) would no longer
// fit it. 409 RSVP_FIELD_TYPE_LOCKED; the organiser adds a new question
// instead. Any other type change is allowed as before. Checked on both
// paths that change a saved question: PUT .../rsvp-fields/:id and the full
// update.
export const RSVP_FIELD_TYPE_LOCKED = 'RSVP_FIELD_TYPE_LOCKED';

export const assertFieldTypeChangeAllowed = async (
  stored: { id: string; label: string; fieldType: RsvpFieldType },
  fieldType: RsvpFieldType | undefined
): Promise<void> => {
  if (fieldType === undefined || fieldType === stored.fieldType) return;
  if (fieldType !== 'DOCUMENT' && stored.fieldType !== 'DOCUMENT') return;
  if ((await rsvpFieldRepository.countAnswers(stored.id)) === 0) return;
  throw new HttpError(
    409,
    `'${stored.label}' already has answers, so it can't be changed to or from a file upload. Add a new field instead.`,
    RSVP_FIELD_TYPE_LOCKED
  );
};

// A question's help text, shown under it (e.g. where to pay before
// uploading the proof). Optional on every type: left out keeps what is
// stored, null or blank clears it, else trimmed text up to
// MAX_FIELD_DESCRIPTION_LENGTH (422 RSVP_FIELD_DESCRIPTION_TOO_LONG). Not
// text at all is an uncoded 400, like any wrong type.
export const MAX_FIELD_DESCRIPTION_LENGTH = 500;
export const RSVP_FIELD_DESCRIPTION_TOO_LONG = 'RSVP_FIELD_DESCRIPTION_TOO_LONG';

export const resolveFieldDescription = (description: unknown, label: string): string | null | undefined => {
  if (description === undefined) return undefined;
  if (description === null) return null;
  if (typeof description !== 'string') throw new HttpError(400, `The description for '${label}' must be text.`);
  const trimmed = description.trim();
  if (trimmed.length > MAX_FIELD_DESCRIPTION_LENGTH) {
    throw new HttpError(
      422,
      `The description for '${label}' must be ${MAX_FIELD_DESCRIPTION_LENGTH} characters or fewer.`,
      RSVP_FIELD_DESCRIPTION_TOO_LONG
    );
  }
  return trimmed || null;
};

export interface RsvpFieldInput {
  label?: unknown;
  fieldType?: unknown;
  options?: unknown;
  description?: unknown;
}

// The label, answer type and description of a NEW question (POST
// .../rsvp-fields and the full event update), and of a change to a saved
// one, omitted fields kept.
export const resolveNewField = (data: RsvpFieldInput) => {
  const label = requireFieldLabel(data.label);
  const fieldType = requireFieldType(data.fieldType, label);
  assertValidFieldOptions(data.options, label);
  const description = resolveFieldDescription(data.description, label);
  return { label, fieldType, description: description ?? null };
};

export const resolveFieldChanges = (data: RsvpFieldInput, existing: { label: string; fieldType: RsvpFieldType }) => {
  const label = data.label !== undefined ? requireFieldLabel(data.label) : undefined;
  const fieldType = data.fieldType !== undefined ? requireFieldType(data.fieldType, label ?? existing.label, existing.fieldType) : undefined;
  assertValidFieldOptions(data.options, label ?? existing.label);
  const description = resolveFieldDescription(data.description, label ?? existing.label);
  return {
    ...(label !== undefined && { label }),
    ...(fieldType !== undefined && { fieldType }),
    ...(description !== undefined && { description }),
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
