import { HttpError } from '../../shared/errors/http-error.js';
import { EVENT_CONSENT_KINDS, type EventConsentKind } from '../consent/consent.types.js';
import { type FeedbackLogoInput, type SaveFeedbackBody, type SaveFeedbackInput } from './feedback.types.js';

// ─────────────────────────────────────────
//  FEEDBACK FORM VALIDATION
//
//  A wrong type is an uncoded 400 (a malformed body). Every 422 carries a
//  code naming its field, so the form can mark it (STEERING "Errors").
// ─────────────────────────────────────────

export const FEEDBACK_ERROR_CODES = {
  EVENT_NOT_COMPLETED: 'FEEDBACK_EVENT_NOT_COMPLETED',
  SCORE_INVALID: 'FEEDBACK_SCORE_INVALID',
  WORKED_BEST_TOO_LONG: 'FEEDBACK_WORKED_BEST_TOO_LONG',
  TO_IMPROVE_TOO_LONG: 'FEEDBACK_TO_IMPROVE_TOO_LONG',
  PHOTO_NOT_ELIGIBLE: 'FEEDBACK_PHOTO_NOT_ELIGIBLE',
  LOGO_INVALID: 'FEEDBACK_LOGO_INVALID',
  LOGO_TOO_LARGE: 'FEEDBACK_LOGO_TOO_LARGE',
} as const;

export const FEEDBACK_SCORE_MIN = 0;
export const FEEDBACK_SCORE_MAX = 10;
export const FEEDBACK_TEXT_MAX_LENGTH = 2000;
// More than any event's photo album should need picking from at once; a
// bound on the list, not a product limit.
export const FEEDBACK_MAX_SELECTED_PHOTOS = 500;

export const scoreRequired = (): HttpError =>
  new HttpError(422, 'Choose a score from 0 to 10.', FEEDBACK_ERROR_CODES.SCORE_INVALID);

const parseScore = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (value === null) throw scoreRequired();
  if (typeof value !== 'number') throw new HttpError(400, 'score must be a number');
  if (!Number.isInteger(value) || value < FEEDBACK_SCORE_MIN || value > FEEDBACK_SCORE_MAX) throw scoreRequired();
  return value;
};

const parseText = (value: unknown, field: string, label: string, tooLongCode: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > FEEDBACK_TEXT_MAX_LENGTH) {
    throw new HttpError(422, `${label} can be at most ${FEEDBACK_TEXT_MAX_LENGTH} characters.`, tooLongCode);
  }
  return trimmed || null;
};

const parsePermissions = (value: unknown): Partial<Record<EventConsentKind, boolean>> => {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'permissions must be an object');
  }
  const permissions: Partial<Record<EventConsentKind, boolean>> = {};
  for (const [key, granted] of Object.entries(value)) {
    if (!(EVENT_CONSENT_KINDS as readonly string[]).includes(key)) {
      throw new HttpError(400, `Unknown permission '${key}'. Expected one of: ${EVENT_CONSENT_KINDS.join(', ')}.`);
    }
    if (typeof granted !== 'boolean') throw new HttpError(400, `permissions.${key} must be true or false`);
    permissions[key as EventConsentKind] = granted;
  }
  return permissions;
};

const parseSelectedPhotoIds = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new HttpError(400, 'selectedPhotoIds must be a list of photo ids');
  }
  const ids = [...new Set(value as string[])];
  if (ids.length > FEEDBACK_MAX_SELECTED_PHOTOS) {
    throw new HttpError(400, `selectedPhotoIds can name at most ${FEEDBACK_MAX_SELECTED_PHOTOS} photos`);
  }
  return ids;
};

const parseLogo = (value: unknown): FeedbackLogoInput | null | undefined => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'logo must be an object or null');
  const { url, publicId, bytes } = value as Record<string, unknown>;
  if (typeof url !== 'string' || !url) throw new HttpError(400, 'logo.url is required');
  if (typeof publicId !== 'string' || !publicId) throw new HttpError(400, 'logo.publicId is required');
  if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0)) {
    throw new HttpError(400, 'logo.bytes must be a positive number');
  }
  return { url, publicId, bytes: bytes as number | undefined };
};

export const parseSaveFeedbackBody = (body: SaveFeedbackBody): SaveFeedbackInput => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return {
    score: parseScore(body.score),
    workedBest: parseText(body.workedBest, 'workedBest', 'What worked best', FEEDBACK_ERROR_CODES.WORKED_BEST_TOO_LONG),
    toImprove: parseText(body.toImprove, 'toImprove', 'What to improve', FEEDBACK_ERROR_CODES.TO_IMPROVE_TOO_LONG),
    permissions: parsePermissions(body.permissions),
    selectedPhotoIds: parseSelectedPhotoIds(body.selectedPhotoIds),
    logo: parseLogo(body.logo),
  };
};
