import { type InvitationStarterCategory } from '@prisma/client';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  parseAltText,
  parseCanvasFormat,
  parseDocumentVersion,
  parseHexColour,
  parseUploadPublicId,
} from '../invitation-design/canvas-design-input.util.js';
import { STARTER_CATEGORIES, STARTER_ERROR_CODES as CODES, STARTER_NAME_MAX_CHARS, type StarterInput } from './invitation-starter.types.js';

// ─────────────────────────────────────────
//  A starter's create or update body (super admin). Its design fields are
//  a CANVAS save's, checked by the same functions (canvas-design-input.util.ts);
//  the document and SVG then by Round 1's own validator and cleaner, in the
//  service. Every unknown key is a 422, never ignored.
// ─────────────────────────────────────────

const KEYS: ReadonlySet<string> = new Set([
  'name', 'category', 'format', 'document', 'documentVersion', 'svg', 'previewPublicId', 'envelopeColor', 'sealColor', 'altText',
]);
const DESIGN_KEYS = ['document', 'documentVersion', 'svg', 'previewPublicId'] as const;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const invalid = (message: string): HttpError => new HttpError(422, message, CODES.FIELD_INVALID);

const parseName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > STARTER_NAME_MAX_CHARS || CONTROL_CHARS.test(name)) {
    throw invalid(`Give the starter a name of 1 to ${STARTER_NAME_MAX_CHARS} characters.`);
  }
  return name;
};

const parseCategory = (value: unknown): InvitationStarterCategory => {
  if (typeof value !== 'string' || !(STARTER_CATEGORIES as readonly string[]).includes(value)) {
    throw invalid(`The category must be one of ${STARTER_CATEGORIES.join(', ')}.`);
  }
  return value as InvitationStarterCategory;
};

export const parseStarterInput = (body: unknown, { creating }: { creating: boolean }): StarterInput => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send the starter as an object.');
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) throw invalid(`A starter has ${unknown.length === 1 ? 'a setting' : 'settings'} that can't be saved: ${unknown.map((k) => `'${k}'`).join(', ')}.`);

  const input: StarterInput = {};
  if (creating || raw['name'] !== undefined) input.name = parseName(raw['name']);
  if (creating || raw['category'] !== undefined) input.category = parseCategory(raw['category']);
  if (creating || raw['format'] !== undefined) input.format = parseCanvasFormat(raw['format']);

  // The design: whole, or not at all.
  const sent = DESIGN_KEYS.filter((k) => raw[k] !== undefined);
  if (sent.length > 0 && sent.length < DESIGN_KEYS.length) {
    throw invalid(`Save the design whole: ${DESIGN_KEYS.join(', ')} go together (missing ${DESIGN_KEYS.filter((k) => raw[k] === undefined).join(', ')}).`);
  }
  if (sent.length === DESIGN_KEYS.length) {
    input.design = {
      // Checked by the validator and the cleaner, in the service.
      document: raw['document'] as Record<string, unknown>,
      documentVersion: parseDocumentVersion(raw['documentVersion']),
      svg: raw['svg'] as string,
      previewPublicId: parseUploadPublicId(raw['previewPublicId'], 'previewPublicId'),
    };
  }
  // A saved design is laid out for its format: the format changes only with it.
  if (!creating && input.format !== undefined && !input.design) {
    throw invalid('Change the format together with the design laid out for it (document, svg and preview).');
  }

  if (raw['envelopeColor'] !== undefined) input.envelopeColor = parseHexColour(raw['envelopeColor'], 'envelope');
  if (raw['sealColor'] !== undefined) input.sealColor = parseHexColour(raw['sealColor'], 'seal');
  if (raw['altText'] !== undefined) input.altText = parseAltText(raw['altText']);
  return input;
};

// GET filters: each optional, refused (400) when it isn't a value we have.
export const parseStarterFilters = (
  query: Record<string, unknown>,
  allowed: { status: boolean }
): { status?: string; category?: string; format?: string } => {
  const filters: { status?: string; category?: string; format?: string } = {};
  const one = (key: string, values: readonly string[]): void => {
    const value = query[key];
    if (value === undefined || value === '') return;
    if (typeof value !== 'string' || !values.includes(value)) {
      throw new HttpError(400, `${key} must be one of ${values.join(', ')}.`);
    }
    (filters as Record<string, string>)[key] = value;
  };
  if (allowed.status) one('status', ['DRAFT', 'PUBLISHED', 'RETIRED']);
  one('category', STARTER_CATEGORIES);
  one('format', ['4:5', '9:16']);
  return filters;
};
