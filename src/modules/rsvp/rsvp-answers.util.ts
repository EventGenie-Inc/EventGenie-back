import { type RsvpFieldType } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isValidEmail, isInternationalPhoneNumber, PHONE_FORMAT_MESSAGE } from '../guest/guest-validation.util.js';

// ─────────────────────────────────────────
//  ANSWERS TO THE EVENT'S OWN QUESTIONS (RsvpField)
//
//  One set of checks and one way to store them, for the two places a guest
//  answers: RSVP submit (rsvp.service.ts) and public self-registration
//  (event-public.service.ts). Same messages, same codes, so an answer is
//  refused the same way wherever it is given. Guest-facing words only.
// ─────────────────────────────────────────

export const RSVP_ANSWER_ERROR_CODES = {
  // A required question left blank by someone attending (422).
  REQUIRED: 'RSVP_ANSWER_REQUIRED',
  // An answer that isn't its question's type: EMAIL, PHONE, NUMBER, or a
  // DROPDOWN answer that isn't one of its options (422).
  INVALID: 'RSVP_ANSWER_INVALID',
  // The same question answered twice in one submission (422; the unique
  // (inviteId, rsvpFieldId) index made it a 500).
  DUPLICATE: 'RSVP_ANSWER_DUPLICATE',
  // An answer to a question this event doesn't have (400: a stale page or
  // a tampered request).
  UNKNOWN_FIELD: 'RSVP_ANSWER_UNKNOWN_FIELD',
} as const;

export interface RsvpAnswer {
  rsvpFieldId: string;
  value: string;
}

export interface AnswerableField {
  id: string;
  label: string;
  fieldType: RsvpFieldType;
  isRequired: boolean;
  options: string | null;
}

export const isValidRsvpResponseShape = (value: unknown): value is RsvpAnswer =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['rsvpFieldId'] === 'string' &&
  ((value as Record<string, unknown>)['rsvpFieldId'] as string).length > 0 &&
  typeof (value as Record<string, unknown>)['value'] === 'string';

// A plain decimal number, as a guest types one: "12", "-3", "2.5". Not
// Number()'s looser idea of a number ("0x1f", "1e3", "Infinity").
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

// A question's choices: the JSON-encoded list of strings rsvp-field-
// validation.util.ts allows. Anything else (none, or an older unreadable
// value) is no choices at all, as the RSVP page reads it.
const choicesOf = (options: string | null): string[] => {
  if (!options) return [];
  try {
    const parsed: unknown = JSON.parse(options);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string').map((c) => c.trim()) : [];
  } catch {
    return [];
  }
};

// The message for an answer that isn't its question's type, or null.
// EMAIL, PHONE and NUMBER have a format, and a DROPDOWN answer must be one
// of its choices (the form sends the choice as written); every other type
// takes any text.
const customAnswerProblem = (field: AnswerableField, value: string): string | null => {
  const { fieldType, label } = field;
  const answer = typeof value === 'string' ? value.trim() : '';
  if (!answer) return null;
  switch (fieldType) {
    case 'DROPDOWN':
      return choicesOf(field.options).includes(answer) ? null : `Choose one of the options for '${label}'.`;
    case 'EMAIL':
      return isValidEmail(answer) ? null : `Enter an email address like name@example.com for '${label}'.`;
    case 'PHONE':
      return isInternationalPhoneNumber(answer) ? null : `${PHONE_FORMAT_MESSAGE} for '${label}'.`;
    case 'NUMBER':
      return PLAIN_NUMBER.test(answer) ? null : `Enter a number for '${label}'.`;
    default:
      return null;
  }
};

// One answer per question. Then custom questions the organiser marked
// required must be answered when attending (a decline needs no answers:
// nothing to cater for). Then an answer to a typed question must be that
// type: EMAIL an email address (guest import's pattern), PHONE an
// international number, NUMBER a number, DROPDOWN one of its choices.
// Checked attending or not, since answers are stored either way; a blank
// answer is no answer, and required-ness is checked before type. Unknown
// field ids are assertAnswersKnown's (RSVP checks them later, inside its
// write).
export const assertAnswersValid = (fields: AnswerableField[], answers: RsvpAnswer[], attending: boolean): void => {
  // First: two answers to one question can't both be stored, and which one
  // the guest meant is unknowable (a stale page or a tampered request).
  const seen = new Set<string>();
  for (const answer of answers) {
    if (seen.has(answer.rsvpFieldId)) {
      throw new HttpError(
        422,
        'One of the questions was answered more than once. Please refresh the page and try again.',
        RSVP_ANSWER_ERROR_CODES.DUPLICATE
      );
    }
    seen.add(answer.rsvpFieldId);
  }

  if (attending) {
    const answered = new Set(answers.filter((r) => r.value.trim().length > 0).map((r) => r.rsvpFieldId));
    const unanswered = fields.filter((f) => f.isRequired && !answered.has(f.id));
    if (unanswered.length > 0) {
      throw new HttpError(
        422,
        `Please answer ${unanswered.map((f) => `'${f.label}'`).join(', ')}. The organiser needs ${unanswered.length === 1 ? 'this' : 'these'} to plan for you.`,
        RSVP_ANSWER_ERROR_CODES.REQUIRED
      );
    }
  }

  for (const answer of answers) {
    const field = fields.find((f) => f.id === answer.rsvpFieldId);
    const message = field ? customAnswerProblem(field, answer.value) : null;
    if (message) throw new HttpError(422, message, RSVP_ANSWER_ERROR_CODES.INVALID);
  }
};

// 400 — a well-shaped but non-existent/wrong-event rsvpFieldId is a
// malformed submission (stale page or tampered request), not something to
// let fall through to a foreign-key violation at write time. `message` is
// the caller's words for where the answer came from.
export const assertAnswersKnown = (fields: { id: string }[], answers: RsvpAnswer[], message: string): void => {
  const validFieldIds = new Set(fields.map((f) => f.id));
  if (answers.some((a) => !validFieldIds.has(a.rsvpFieldId))) {
    throw new HttpError(400, message, RSVP_ANSWER_ERROR_CODES.UNKNOWN_FIELD);
  }
};

// The rows stored, value as given, for one invite.
export const answerRows = (inviteId: string, answers: RsvpAnswer[]) =>
  answers.map((answer) => ({ inviteId, rsvpFieldId: answer.rsvpFieldId, value: answer.value }));
