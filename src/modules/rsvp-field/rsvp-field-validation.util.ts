import { type RsvpFieldType } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { DOCUMENT_ERROR_CODES, DOCUMENT_FIELDS_UNAVAILABLE_MESSAGE } from '../guest-document/guest-document.types.js';
import { rsvpFieldRepository } from './rsvp-field.repository.js';

const FIELD_TYPES: readonly RsvpFieldType[] = ['TEXT', 'NUMBER', 'EMAIL', 'PHONE', 'DROPDOWN', 'CHECKBOX', 'DATE', 'DOCUMENT', 'MULTI_SELECT'];

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

// A question with answers can't become a file upload or a multi-select,
// nor stop being one: the answers already given (text, references to
// files, or lists of choices) would no longer fit it. 409
// RSVP_FIELD_TYPE_LOCKED; the organiser adds a new question instead. Any
// other type change is allowed as before. Checked on both paths that change
// a saved question: PUT .../rsvp-fields/:id and the full update.
export const RSVP_FIELD_TYPE_LOCKED = 'RSVP_FIELD_TYPE_LOCKED';

const LOCKED_TYPES: readonly RsvpFieldType[] = ['DOCUMENT', 'MULTI_SELECT'];

export const assertFieldTypeChangeAllowed = async (
  stored: { id: string; label: string; fieldType: RsvpFieldType },
  fieldType: RsvpFieldType | undefined
): Promise<void> => {
  if (fieldType === undefined || fieldType === stored.fieldType) return;
  if (!LOCKED_TYPES.includes(fieldType) && !LOCKED_TYPES.includes(stored.fieldType)) return;
  if ((await rsvpFieldRepository.countAnswers(stored.id)) === 0) return;
  const what = fieldType === 'DOCUMENT' || stored.fieldType === 'DOCUMENT' ? 'a file upload' : 'multi-select';
  throw new HttpError(
    409,
    `'${stored.label}' already has answers, so it can't be changed to or from ${what}. Add a new field instead.`,
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
  assertChoiceOptions(fieldType, data.options as string | null | undefined, label);
  const description = resolveFieldDescription(data.description, label);
  return { label, fieldType, description: description ?? null };
};

// A saved question's choices are held to assertChoiceOptions only when the
// save changes them or makes the question a choice one: a DROPDOWN or
// MULTI_SELECT question saved before the rule, re-sent as it is (the full
// update sends every question) or edited elsewhere (its label), still saves.
export const resolveFieldChanges = (
  data: RsvpFieldInput,
  existing: { label: string; fieldType: RsvpFieldType; options: string | null }
) => {
  const label = data.label !== undefined ? requireFieldLabel(data.label) : undefined;
  const fieldType = data.fieldType !== undefined ? requireFieldType(data.fieldType, label ?? existing.label, existing.fieldType) : undefined;
  assertValidFieldOptions(data.options, label ?? existing.label);
  const resultingType = fieldType ?? existing.fieldType;
  const resultingOptions = data.options !== undefined ? (data.options as string | null) : existing.options;
  const typeChanged = resultingType !== existing.fieldType;
  const optionsChanged = (resultingOptions ?? null) !== (existing.options ?? null);
  if (typeChanged || optionsChanged) assertChoiceOptions(resultingType, resultingOptions, label ?? existing.label);
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

// A choice question's options (DROPDOWN, "Multiple choice" in the
// interface, and MULTI_SELECT), once they are a valid list
// (assertValidFieldOptions): no blank option (RSVP_FIELD_OPTION_BLANK), no
// option twice, compared trimmed and ignoring case
// (RSVP_FIELD_OPTION_DUPLICATE), and at least two
// (RSVP_FIELD_OPTIONS_TOO_FEW; none sent is none), checked in that order,
// all 422. Other types' options are not checked. Applied when a question is
// saved: created (POST .../rsvp-fields, the full update, the wizard's
// materialize) or changed (resolveFieldChanges). Stored options are never
// rewritten.
export const RSVP_FIELD_OPTION_BLANK = 'RSVP_FIELD_OPTION_BLANK';
export const RSVP_FIELD_OPTION_DUPLICATE = 'RSVP_FIELD_OPTION_DUPLICATE';
export const RSVP_FIELD_OPTIONS_TOO_FEW = 'RSVP_FIELD_OPTIONS_TOO_FEW';
export const MIN_CHOICE_OPTIONS = 2;

const CHOICE_TYPES: readonly RsvpFieldType[] = ['DROPDOWN', 'MULTI_SELECT'];

export const assertChoiceOptions = (fieldType: RsvpFieldType, options: string | null | undefined, label: string): void => {
  if (!CHOICE_TYPES.includes(fieldType)) return;
  const choices: string[] = options ? (JSON.parse(options) as string[]) : [];
  if (choices.some((choice) => choice.trim() === '')) {
    throw new HttpError(422, `Each option for '${label}' needs text. Remove the blank one.`, RSVP_FIELD_OPTION_BLANK);
  }
  const seen = new Set<string>();
  for (const choice of choices) {
    const key = choice.trim().toLowerCase();
    if (seen.has(key)) {
      throw new HttpError(422, `'${label}' has the option '${choice.trim()}' more than once.`, RSVP_FIELD_OPTION_DUPLICATE);
    }
    seen.add(key);
  }
  if (choices.length < MIN_CHOICE_OPTIONS) {
    throw new HttpError(422, `'${label}' needs at least ${MIN_CHOICE_OPTIONS} options.`, RSVP_FIELD_OPTIONS_TOO_FEW);
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
