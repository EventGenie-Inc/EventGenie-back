// ─────────────────────────────────────────
//  CANVAS DESIGNS — the organiser's own invitation, made in the browser's
//  editor (Fabric.js) and saved as three things: the design document (the
//  editor's JSON, the organiser's only), an SVG of the card (cleaned here,
//  what guests see) and a rendered PNG (email and share previews).
//
//  STEERING "Invitation designs". Dependency-free, so the frontend can copy
//  the font list and the numbers as they are.
// ─────────────────────────────────────────

// Both formats are 1080 canvas units wide; the height is the format's.
export const CANVAS_WIDTH = 1080;
export const CANVAS_FORMATS = { '4:5': 1350, '9:16': 1920 } as const;
export type CanvasFormat = keyof typeof CANVAS_FORMATS;

export const isCanvasFormat = (value: unknown): value is CanvasFormat =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(CANVAS_FORMATS, value);

// ─────────────────────────────────────────
//  FONTS — the only families a CANVAS design may use, self-hosted by the
//  frontend (all SIL Open Font License). The frontend holds an exact copy;
//  the two change together, backend first. Spelled as Google Fonts spells
//  them. Removing one breaks re-saving every design that uses it.
//
//  Not the template engine's INVITATION_FONT_ALLOWLIST
//  (invitation-design-fonts.ts), which stays as it is until the template
//  engine is removed.
// ─────────────────────────────────────────
export const CANVAS_FONT_ALLOWLIST = [
  'Fraunces',
  'Inter',
  'Poppins',
  'Playfair Display',
  'Cormorant Garamond',
  'Montserrat',
  'Lora',
  'DM Serif Display',
  'Great Vibes',
  'Dancing Script',
] as const;
export type CanvasFont = (typeof CANVAS_FONT_ALLOWLIST)[number];

// ─────────────────────────────────────────
//  LIMITS
// ─────────────────────────────────────────

// 12px on a 360px-wide card (the narrowest a guest sees it): 1080 / 360 * 12.
// The size a text is DRAWN at: its fontSize times its vertical scale (and
// its group's, for the RSVP button's label).
export const CANVAS_MIN_TEXT_UNITS = 36;
// A heading can't be wider than the card anyway past this.
export const CANVAS_MAX_TEXT_UNITS = 600;

export const CANVAS_MAX_ELEMENTS = 100;
export const CANVAS_MAX_IMAGES = 10;
// The document as sent, serialised. Images are URLs, never embedded data.
export const CANVAS_DOCUMENT_MAX_BYTES = 200 * 1024;
// The cleaned SVG, as stored and served.
export const CANVAS_SVG_MAX_BYTES = 300 * 1024;
// The SVG as the browser sends it, before cleaning: refused unread above
// this, so cleaning never parses something enormous. Fabric's export of a
// 100-element card is far below it.
export const CANVAS_SVG_INPUT_MAX_BYTES = 1024 * 1024;

export const CANVAS_TEXT_MAX_CHARS = 1000;
export const CANVAS_ALT_TEXT_MAX_CHARS = 300;
export const CANVAS_DOCUMENT_VERSION_MAX = 1000;

// One path's drawing (an icon, an illustration), serialised: its document
// `path` as JSON, and its SVG `d`. The location pin is under 1KB; a detailed
// illustration a few KB. Larger belongs in an image.
export const CANVAS_PATH_MAX_BYTES = 20 * 1024;

// ─────────────────────────────────────────
//  ERROR CODES (HttpError.code). Every refusal of a CANVAS save is 422 with
//  one of these, except the plan's (403) and the storage ones
//  (UPLOAD_NOT_FOUND and friends).
// ─────────────────────────────────────────
export const CANVAS_ERROR_CODES = {
  // 403: the plan has no invitationDesignsEnabled (saving, or an upload signature).
  NOT_ON_PLAN: 'INVITATION_DESIGNS_NOT_ON_PLAN',
  // A body field: format, documentVersion, colours, alt text, unknown keys.
  FIELD_INVALID: 'DESIGN_FIELD_INVALID',
  // The document's shape: an unknown key, a value of the wrong type or range.
  DOCUMENT_INVALID: 'DESIGN_DOCUMENT_INVALID',
  DOCUMENT_TOO_LARGE: 'DESIGN_DOCUMENT_TOO_LARGE',
  ELEMENT_NOT_ALLOWED: 'DESIGN_ELEMENT_NOT_ALLOWED',
  FONT_NOT_ALLOWED: 'DESIGN_FONT_NOT_ALLOWED',
  IMAGE_SOURCE_NOT_ALLOWED: 'DESIGN_IMAGE_SOURCE_NOT_ALLOWED',
  TEXT_TOO_SMALL: 'DESIGN_TEXT_TOO_SMALL',
  COLOUR_INVALID: 'DESIGN_COLOUR_INVALID',
  TOO_MANY_ELEMENTS: 'DESIGN_TOO_MANY_ELEMENTS',
  TOO_MANY_IMAGES: 'DESIGN_TOO_MANY_IMAGES',
  RSVP_BUTTON_DUPLICATE: 'DESIGN_RSVP_BUTTON_DUPLICATE',
  // A path's drawing: anything but path commands and numbers, or over
  // CANVAS_PATH_MAX_BYTES.
  PATH_INVALID: 'DESIGN_PATH_INVALID',
  PATH_TOO_LARGE: 'DESIGN_PATH_TOO_LARGE',
  // The SVG: not one <svg> we can read, the wrong viewBox, too large after
  // cleaning, or its RSVP marker not matching the document.
  SVG_INVALID: 'DESIGN_SVG_INVALID',
  SVG_VIEWBOX_MISMATCH: 'DESIGN_SVG_VIEWBOX_MISMATCH',
  SVG_TOO_LARGE: 'DESIGN_SVG_TOO_LARGE',
  SVG_RSVP_MISMATCH: 'DESIGN_SVG_RSVP_MISMATCH',
  // The rendered card: not PNG or WebP, or not 1080 x the format's height.
  // (Too large is DESIGN_RENDER_TOO_LARGE.)
  RENDER_INVALID: 'DESIGN_RENDER_INVALID',
  RENDER_TOO_LARGE: 'DESIGN_RENDER_TOO_LARGE',
  // An upload signature for something the route doesn't sign.
  UPLOAD_PURPOSE_INVALID: 'DESIGN_UPLOAD_PURPOSE_INVALID',
} as const;
