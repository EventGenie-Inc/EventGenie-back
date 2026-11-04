import { type RsvpFieldType } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import { isValidEmail, isInternationalPhoneNumber, PHONE_FORMAT_MESSAGE } from '../guest/guest-validation.util.js';
import { isFeatureEnabled } from '../../shared/features/feature-flags.js';
import { DOCUMENT_ERROR_CODES } from '../guest-document/guest-document.types.js';

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
  // An answer that isn't its question's type: EMAIL, PHONE, NUMBER, a
  // DROPDOWN answer that isn't one of its options, or a CHECKBOX answer
  // other than "true" or "false" (422).
  INVALID: 'RSVP_ANSWER_INVALID',
  // The same question answered twice in one submission (422; the unique
  // (inviteId, rsvpFieldId) index made it a 500).
  DUPLICATE: 'RSVP_ANSWER_DUPLICATE',
  // An answer to a question this event doesn't have (400: a stale page or
  // a tampered request).
  UNKNOWN_FIELD: 'RSVP_ANSWER_UNKNOWN_FIELD',
  // A MULTI_SELECT answer naming something that isn't one of the
  // question's options (422).
  UNKNOWN_OPTION: 'RSVP_ANSWER_UNKNOWN_OPTION',
  // A required MULTI_SELECT question with nothing chosen by someone
  // attending (422).
  NONE_CHOSEN: 'RSVP_ANSWER_NONE_CHOSEN',
} as const;

// The questions a guest can answer: every one, except DOCUMENT questions
// while documentFields is off. Those are never shown to a guest then, so
// they are never required, and an answer to one is an unknown question.
export const answerableFields = <T extends { fieldType: RsvpFieldType }>(fields: T[]): T[] =>
  isFeatureEnabled('documentFields') ? fields : fields.filter((f) => f.fieldType !== 'DOCUMENT');

// An answer as a guest sends it: text for every type, except MULTI_SELECT,
// whose answer is the list of chosen options (empty: none chosen). Stored
// as text either way (answerRows); read back with answerValue.
export interface RsvpAnswer {
  rsvpFieldId: string;
  value: string | string[];
}

export interface AnswerableField {
  id: string;
  label: string;
  fieldType: RsvpFieldType;
  isRequired: boolean;
  options: string | null;
}

export const isValidRsvpResponseShape = (value: unknown): value is RsvpAnswer => {
  if (typeof value !== 'object' || value === null) return false;
  const { rsvpFieldId, value: answer } = value as Record<string, unknown>;
  return (
    typeof rsvpFieldId === 'string' &&
    rsvpFieldId.length > 0 &&
    (typeof answer === 'string' || (Array.isArray(answer) && answer.every((choice) => typeof choice === 'string')))
  );
};

// Something chosen or written: a list with anything in it, or text that
// isn't blank.
const isAnswered = (value: string | string[]): boolean =>
  Array.isArray(value) ? value.length > 0 : value.trim().length > 0;

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
// EMAIL, PHONE and NUMBER have a format, a DROPDOWN answer must be one of
// its choices (the form sends the choice as written), and a CHECKBOX is
// exactly "true" or "false", as stored (the RSVP page and the export read
// anything but "true" as No); every other type takes any text.
const customAnswerProblem = (field: AnswerableField, value: string): string | null => {
  const { fieldType, label } = field;
  const answer = value.trim();
  if (!answer) return null;
  switch (fieldType) {
    case 'CHECKBOX':
      return value === 'true' || value === 'false' ? null : `Tick the box for '${label}', or leave it unticked.`;
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

// A MULTI_SELECT answer: a list (text is not its shape), each choice one
// of the question's options (RSVP_ANSWER_UNKNOWN_OPTION), none twice. Any
// other type's answer is text (a list is not its shape). Both shape
// refusals, and a choice given twice, are RSVP_ANSWER_INVALID.
const answerProblem = (field: AnswerableField, value: string | string[]): { message: string; code: string } | null => {
  const { fieldType, label } = field;
  const invalid = (message: string) => ({ message, code: RSVP_ANSWER_ERROR_CODES.INVALID });
  if (fieldType === 'MULTI_SELECT') {
    if (!Array.isArray(value)) return invalid(`Choose one or more of the options for '${label}'.`);
    const choices = choicesOf(field.options);
    const chosen = value.map((choice) => choice.trim());
    if (chosen.some((choice) => !choices.includes(choice))) {
      return { message: `Choose only from the options for '${label}'.`, code: RSVP_ANSWER_ERROR_CODES.UNKNOWN_OPTION };
    }
    if (new Set(chosen).size !== chosen.length) return invalid(`Choose each option for '${label}' only once.`);
    return null;
  }
  if (Array.isArray(value)) return invalid(`Give one answer for '${label}'.`);
  const message = customAnswerProblem(field, value);
  return message ? invalid(message) : null;
};

// One answer per question. Then custom questions the organiser marked
// required must be answered when attending (a decline needs no answers:
// nothing to cater for). Then an answer to a typed question must be that
// type: EMAIL an email address (guest import's pattern), PHONE an
// international number, NUMBER a number, DROPDOWN one of its choices,
// CHECKBOX "true" or "false", MULTI_SELECT a list of its choices
// (answerProblem). A required MULTI_SELECT with nothing chosen has its own
// code, after the other unanswered questions and before a missing file.
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

  const visible = answerableFields(fields);
  if (attending) {
    const answered = new Set(answers.filter((r) => isAnswered(r.value)).map((r) => r.rsvpFieldId));
    const unanswered = visible.filter((f) => f.isRequired && !answered.has(f.id));
    // Typed questions first, as before; then a required file (its own code:
    // the form marks the upload, not a text box).
    const unansweredQuestions = unanswered.filter((f) => f.fieldType !== 'DOCUMENT' && f.fieldType !== 'MULTI_SELECT');
    if (unansweredQuestions.length > 0) {
      throw new HttpError(
        422,
        `Please answer ${unansweredQuestions.map((f) => `'${f.label}'`).join(', ')}. The organiser needs ${unansweredQuestions.length === 1 ? 'this' : 'these'} to plan for you.`,
        RSVP_ANSWER_ERROR_CODES.REQUIRED
      );
    }
    const noneChosen = unanswered.filter((f) => f.fieldType === 'MULTI_SELECT');
    if (noneChosen.length > 0) {
      throw new HttpError(
        422,
        `Please choose at least one option for ${noneChosen.map((f) => `'${f.label}'`).join(', ')}. The organiser needs ${noneChosen.length === 1 ? 'this' : 'these'} to plan for you.`,
        RSVP_ANSWER_ERROR_CODES.NONE_CHOSEN
      );
    }
    const missingFiles = unanswered.filter((f) => f.fieldType === 'DOCUMENT');
    if (missingFiles.length > 0) {
      throw new HttpError(
        422,
        `Please upload ${missingFiles.map((f) => `'${f.label}'`).join(', ')}. The organiser needs ${missingFiles.length === 1 ? 'it' : 'them'} to confirm your place.`,
        DOCUMENT_ERROR_CODES.REQUIRED
      );
    }
  }

  for (const answer of answers) {
    const field = visible.find((f) => f.id === answer.rsvpFieldId);
    const problem = field ? answerProblem(field, answer.value) : null;
    if (problem) throw new HttpError(422, problem.message, problem.code);
  }
};

// 400 — a well-shaped but non-existent/wrong-event rsvpFieldId is a
// malformed submission (stale page or tampered request), not something to
// let fall through to a foreign-key violation at write time. `message` is
// the caller's words for where the answer came from.
export const assertAnswersKnown = (fields: { id: string; fieldType: RsvpFieldType }[], answers: RsvpAnswer[], message: string): void => {
  const validFieldIds = new Set(answerableFields(fields).map((f) => f.id));
  if (answers.some((a) => !validFieldIds.has(a.rsvpFieldId))) {
    throw new HttpError(400, message, RSVP_ANSWER_ERROR_CODES.UNKNOWN_FIELD);
  }
};

// The rows stored for one invite: text as given; a MULTI_SELECT list as
// the JSON-encoded list of its trimmed choices, in the order given, or ''
// for none chosen (no answer, as a blank one is: rsvp-field.repository's
// countAnswers doesn't count it). Only after assertAnswersValid, which
// lets a list through for a MULTI_SELECT question only.
export const storedAnswer = (value: string | string[]): string =>
  Array.isArray(value) ? (value.length > 0 ? JSON.stringify(value.map((choice) => choice.trim())) : '') : value;

export const answerRows = (inviteId: string, answers: RsvpAnswer[]) =>
  answers.map((answer) => ({ inviteId, rsvpFieldId: answer.rsvpFieldId, value: storedAnswer(answer.value) }));

// A stored answer as it is read back (the guest's page, the submit
// response, the organiser's guest details): a MULTI_SELECT answer as its
// list of choices (none: []), so it goes back exactly as it is sent;
// anything else as the stored text. A MULTI_SELECT value that isn't a
// JSON list (never written: the type can't change once answered,
// rsvp-field-validation.util.ts) reads as that one text.
export const answerValue = (fieldType: RsvpFieldType, value: string): string | string[] => {
  if (fieldType !== 'MULTI_SELECT') return value;
  if (value.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((choice) => typeof choice === 'string')) return parsed;
  } catch {
    // Not a list: falls through.
  }
  return [value];
};

// answerValue over rows whose question type is known by id; a row for a
// question not listed is left as stored.
export const withAnswerValues = <T extends { rsvpFieldId: string; value: string }>(
  rows: T[],
  fields: { id: string; fieldType: RsvpFieldType }[]
): (Omit<T, 'value'> & { value: string | string[] })[] => {
  const typeOf = new Map(fields.map((f) => [f.id, f.fieldType]));
  return rows.map((row) => {
    const fieldType = typeOf.get(row.rsvpFieldId);
    return { ...row, value: fieldType ? answerValue(fieldType, row.value) : row.value };
  });
};
