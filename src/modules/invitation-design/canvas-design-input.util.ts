import { HttpError } from '../../shared/errors/http-error.js';
import {
  CANVAS_ALT_TEXT_MAX_CHARS,
  CANVAS_DOCUMENT_VERSION_MAX,
  CANVAS_ERROR_CODES as CODES,
  isCanvasFormat,
} from './canvas-design.constants.js';
import { type PutCanvasDesignDto } from './invitation-design.types.js';

// ─────────────────────────────────────────
//  A CANVAS save's own fields (PUT /api/events/:eventId/invitation-design
//  with kind 'CANVAS'). The document and the SVG are checked by their own
//  modules (canvas-document-validation.util.ts, canvas-svg-sanitiser.util.ts);
//  here only that each field is there and of its type. An unknown key is a
//  422, never ignored.
// ─────────────────────────────────────────

const CANVAS_BODY_KEYS: ReadonlySet<string> = new Set([
  'kind', 'format', 'document', 'documentVersion', 'svg', 'pngPublicId', 'envelopeColor', 'sealColor', 'altText',
]);
const HEX = /^#[0-9A-Fa-f]{6}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const invalid = (message: string, code: string = CODES.FIELD_INVALID): HttpError => new HttpError(422, message, code);

export const assertCanvasBody = (body: Record<string, unknown>): PutCanvasDesignDto => {
  const unknown = Object.keys(body).filter((k) => !CANVAS_BODY_KEYS.has(k));
  if (unknown.length > 0) {
    throw invalid(`A design has ${unknown.length === 1 ? 'a setting' : 'settings'} that can't be saved: ${unknown.map((k) => `'${k}'`).join(', ')}.`);
  }

  const { format, documentVersion, envelopeColor, sealColor, pngPublicId } = body;
  if (!isCanvasFormat(format)) throw invalid("The format must be '4:5' or '9:16'.");
  if (typeof documentVersion !== 'number' || !Number.isInteger(documentVersion) || documentVersion < 1 || documentVersion > CANVAS_DOCUMENT_VERSION_MAX) {
    throw invalid('The design version must be a whole number of 1 or more.');
  }
  if (typeof envelopeColor !== 'string' || !HEX.test(envelopeColor)) {
    throw invalid('The envelope colour must be a colour like #FAF7F2 (a # and six hex digits).', CODES.COLOUR_INVALID);
  }
  if (typeof sealColor !== 'string' || !HEX.test(sealColor)) {
    throw invalid('The seal colour must be a colour like #6C4CF1 (a # and six hex digits).', CODES.COLOUR_INVALID);
  }
  if (typeof pngPublicId !== 'string' || pngPublicId.length === 0) {
    throw invalid("The design's picture (pngPublicId) is missing. Save it again from the editor.");
  }

  const rawAlt = body['altText'];
  if (typeof rawAlt !== 'string' || CONTROL_CHARS.test(rawAlt)) throw invalid('Describe the design in plain text (altText), for guests using a screen reader.');
  const altText = rawAlt.trim();
  if (altText.length === 0) throw invalid('Describe the design (altText), for guests using a screen reader.');
  if ([...altText].length > CANVAS_ALT_TEXT_MAX_CHARS) {
    throw invalid(`The design's description is too long. Keep it to ${CANVAS_ALT_TEXT_MAX_CHARS} characters or fewer.`);
  }

  return {
    kind: 'CANVAS',
    format,
    // Checked by assertValidCanvasDocument and cleanCanvasSvg, after this.
    document: body['document'] as Record<string, unknown>,
    documentVersion,
    svg: body['svg'] as string,
    pngPublicId,
    envelopeColor: envelopeColor.toUpperCase(),
    sealColor: sealColor.toUpperCase(),
    altText,
  };
};
