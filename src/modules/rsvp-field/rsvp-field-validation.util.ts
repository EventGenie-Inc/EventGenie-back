import { type RsvpFieldType } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';

const FIELD_TYPES: readonly RsvpFieldType[] = ['TEXT', 'NUMBER', 'EMAIL', 'PHONE', 'DROPDOWN', 'CHECKBOX', 'DATE'];

// A custom RSVP question needs the question itself (the wizard marks the
// label required) and a known answer type. Shared by the rsvp-field
// endpoints and the wizard's materialize path. 422 — a blank label used to
// be saved, and an unknown type reached Prisma as a generic 500.
export const requireFieldLabel = (label: unknown): string => {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (!trimmed) throw new HttpError(422, 'Each custom RSVP question needs a label — the question your guests will see.');
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
}

// The label and answer type of a NEW question (POST .../rsvp-fields and the
// full event update), and of a change to a saved one, omitted fields kept.
export const resolveNewField = (data: RsvpFieldInput) => {
  const label = requireFieldLabel(data.label);
  return { label, fieldType: requireFieldType(data.fieldType, label) };
};

export const resolveFieldChanges = (data: RsvpFieldInput, existing: { label: string }) => {
  const label = data.label !== undefined ? requireFieldLabel(data.label) : undefined;
  const fieldType = data.fieldType !== undefined ? requireFieldType(data.fieldType, label ?? existing.label) : undefined;
  return {
    ...(label !== undefined && { label }),
    ...(fieldType !== undefined && { fieldType }),
  };
};
