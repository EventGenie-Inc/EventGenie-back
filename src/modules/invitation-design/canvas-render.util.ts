import { HttpError } from '../../shared/errors/http-error.js';
import { DESIGN_RENDER_MAX_BYTES } from '../upload/upload-constants.js';
import { CANVAS_ERROR_CODES, CANVAS_FORMATS, CANVAS_WIDTH, type CanvasFormat } from './canvas-design.constants.js';

// ─────────────────────────────────────────
//  A RENDERED CARD's checks — an organiser's design's picture
//  (DESIGN_RENDER) and a starter's preview (STARTER_RENDER) alike, on
//  Cloudinary's own figures (acceptUpload with measureImage): PNG or WebP,
//  exactly 1080 wide and the format's height, at most 5MB.
// ─────────────────────────────────────────

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

// The refusal acceptUpload gives for a card over 5MB (it is then deleted).
export const renderTooLarge = (bytes: number): HttpError => new HttpError(
  422,
  `This design's picture is too large (${mb(bytes)}MB; the limit is ${DESIGN_RENDER_MAX_BYTES / (1024 * 1024)}MB). Export it as WebP, or with fewer photos.`,
  CANVAS_ERROR_CODES.RENDER_TOO_LARGE
);

// 422 DESIGN_RENDER_INVALID unless it is a PNG or WebP of exactly the format's size.
export const assertRenderFits = (
  image: { width: number | null; height: number | null; format: string | null } | undefined,
  format: CanvasFormat
): void => {
  const height = CANVAS_FORMATS[format];
  if (image?.format !== 'png' && image?.format !== 'webp') {
    throw new HttpError(422, "This design's picture must be a PNG or WebP image. Save the design again from the editor.", CANVAS_ERROR_CODES.RENDER_INVALID);
  }
  if (image.width !== CANVAS_WIDTH || image.height !== height) {
    throw new HttpError(
      422,
      `This design's picture must be ${CANVAS_WIDTH} by ${height} pixels for the ${format} format ` +
      `(it is ${image.width ?? '?'} by ${image.height ?? '?'}). Save the design again from the editor.`,
      CANVAS_ERROR_CODES.RENDER_INVALID
    );
  }
};
