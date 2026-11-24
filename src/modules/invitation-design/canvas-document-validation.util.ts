import { HttpError } from '../../shared/errors/http-error.js';
import { designAssetFolder, isSignedPublicIdInFolder } from '../upload/upload-folders.js';
import {
  CANVAS_DOCUMENT_MAX_BYTES,
  CANVAS_ERROR_CODES as CODES,
  CANVAS_FONT_ALLOWLIST,
  CANVAS_MAX_ELEMENTS,
  CANVAS_MAX_IMAGES,
  CANVAS_MAX_TEXT_UNITS,
  CANVAS_MIN_TEXT_UNITS,
  CANVAS_TEXT_MAX_CHARS,
} from './canvas-design.constants.js';

// ─────────────────────────────────────────
//  THE DESIGN DOCUMENT — an allowlist over Fabric.js's own JSON
//
//  The browser sends `canvas.toObject(['egId', 'egLabel', 'egSource',
//  'egRole'])` from Fabric 7.4: { version, objects: [...], background?,
//  backgroundImage? }. Every key of every object is on a list below, every
//  value has a fixed type and range, and anything else is a 422 naming it,
//  never dropped: the document is stored as sent and loaded back into the
//  editor, so what is stored must be exactly what was checked.
//
//  Element types (Fabric's class name, `type`) and what they are here:
//    Textbox  text
//    Image    image (also the canvas's backgroundImage)
//    Rect     rect
//    Circle   circle
//    Line     line
//    Group    only with egRole 'rsvpButton': the RSVP button, a styled
//             group of shapes and one label, which the guest page turns
//             into the real RSVP link. At most one. No other group.
//  Anything else (Path, Polygon, IText, Text, Triangle, Ellipse, a plain
//  Group, ActiveSelection...) is DESIGN_ELEMENT_NOT_ALLOWED.
//
//  Fabric writes every default property on every object, so its full set is
//  listed, each pinned to a harmless value where the editor doesn't use it
//  (shadow null, filters empty, compositing source-over, no per-character
//  styles, no text on a path). This module never reads a key it hasn't
//  checked.
// ─────────────────────────────────────────

type Obj = Record<string, unknown>;
type Check = (value: unknown, where: string, key: string) => void;

const HEX = /^#[0-9A-Fa-f]{6}$/;
// Fabric's own default fill on objects that never paint one (an image, a
// line, a group). Accepted only as that untouched default on those types.
const FABRIC_DEFAULT_FILL = 'rgb(0,0,0)';
const FABRIC_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// egId: the editor's element id; egLabel: the layer name it shows;
// egSource: which event detail a text was filled from ('hostName', 'date').
const EG_ID = /^[A-Za-z0-9_-]{1,40}$/;
const EG_SOURCE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
// Every control character except a line break and a tab.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

// Positions are canvas units; a little off the card is fine (a bleed), far
// off it isn't anything. Sizes likewise.
const COORD_MAX = 10_000;
const SIZE_MAX = 20_000;
const LABEL_MAX_CHARS = 100;
const RSVP_BUTTON_MAX_CHILDREN = 10;

const invalid = (code: string, message: string): HttpError => new HttpError(422, message, code);
const documentInvalid = (message: string): HttpError => invalid(CODES.DOCUMENT_INVALID, message);

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

// ── Value checks ──────────────────────────

const num = (min: number, max: number): Check => (value, where, key) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw documentInvalid(`${where}: '${key}' must be a number between ${min} and ${max}.`);
  }
};
const bool: Check = (value, where, key) => {
  if (typeof value !== 'boolean') throw documentInvalid(`${where}: '${key}' must be true or false.`);
};
const oneOf = (...allowed: readonly unknown[]): Check => (value, where, key) => {
  if (!allowed.includes(value)) {
    throw documentInvalid(`${where}: '${key}' must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}.`);
  }
};
const isNull: Check = (value, where, key) => {
  if (value !== null) throw documentInvalid(`${where}: '${key}' isn't supported, so it must be null.`);
};
const emptyArray: Check = (value, where, key) => {
  if (!Array.isArray(value) || value.length > 0) throw documentInvalid(`${where}: '${key}' isn't supported, so it must be empty.`);
};
const colourWith = (opts: { empty?: boolean; fabricDefault?: boolean }): Check => (value, where, key) => {
  if (typeof value === 'string' && HEX.test(value)) return;
  if (opts.empty && (value === '' || value === null)) return;
  if (opts.fabricDefault && value === FABRIC_DEFAULT_FILL) return;
  throw invalid(CODES.COLOUR_INVALID, `${where}: '${key}' must be a colour like #1F2937 (a # and six hex digits).`);
};
const hexColour = colourWith({});
const colourOrNone = colourWith({ empty: true });
const unpaintedFill = colourWith({ empty: true, fabricDefault: true });
const pattern = (re: RegExp, what: string): Check => (value, where, key) => {
  if (typeof value !== 'string' || !re.test(value)) throw documentInvalid(`${where}: '${key}' must be ${what}.`);
};
const plainText = (maxChars: number): Check => (value, where, key) => {
  if (typeof value !== 'string' || CONTROL_CHARS.test(value)) throw documentInvalid(`${where}: '${key}' must be plain text.`);
  if ([...value].length > maxChars) throw documentInvalid(`${where}: '${key}' is too long. Keep it to ${maxChars} characters or fewer.`);
};
const dashArray: Check = (value, where, key) => {
  if (value === null) return;
  if (!Array.isArray(value) || value.length > 8 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000)) {
    throw documentInvalid(`${where}: '${key}' must be null or up to 8 dash lengths.`);
  }
};
// Per-character styles would carry fonts and sizes past every check here:
// Fabric writes an empty array (or object) when there are none.
const noCharacterStyles: Check = (value, where, key) => {
  const empty = (Array.isArray(value) && value.length === 0) || (isObj(value) && Object.keys(value).length === 0);
  if (!empty) throw documentInvalid(`${where}: '${key}' (per-character styling) isn't supported, so it must be empty.`);
};
const fontFamily: Check = (value, where) => {
  if (typeof value !== 'string' || !(CANVAS_FONT_ALLOWLIST as readonly string[]).includes(value)) {
    throw invalid(CODES.FONT_NOT_ALLOWED, `${where}: '${String(value)}' isn't one of the available fonts. Choose from: ${CANVAS_FONT_ALLOWLIST.join(', ')}.`);
  }
};
const fontWeight = oneOf('normal', 'bold', 400, 700, '400', '700');

// ── Keys per type ─────────────────────────

// Every object (FabricObject.toObject in 7.4), plus the editor's own.
const COMMON_KEYS: Record<string, Check> = {
  version: pattern(FABRIC_VERSION, "Fabric's version, like 7.4.0"),
  originX: oneOf('left', 'center', 'right'),
  originY: oneOf('top', 'center', 'bottom'),
  left: num(-COORD_MAX, COORD_MAX),
  top: num(-COORD_MAX, COORD_MAX),
  width: num(0, SIZE_MAX),
  height: num(0, SIZE_MAX),
  stroke: colourOrNone,
  strokeWidth: num(0, 200),
  strokeDashArray: dashArray,
  strokeLineCap: oneOf('butt', 'round', 'square'),
  strokeDashOffset: num(-1000, 1000),
  strokeLineJoin: oneOf('miter', 'round', 'bevel'),
  strokeUniform: bool,
  strokeMiterLimit: num(0, 100),
  scaleX: num(0.001, 100),
  scaleY: num(0.001, 100),
  angle: num(-360, 360),
  flipX: bool,
  flipY: bool,
  opacity: num(0, 1),
  shadow: isNull,
  visible: bool,
  backgroundColor: colourOrNone,
  fillRule: oneOf('nonzero', 'evenodd'),
  paintFirst: oneOf('fill', 'stroke'),
  globalCompositeOperation: oneOf('source-over'),
  skewX: num(-89, 89),
  skewY: num(-89, 89),
  egId: pattern(EG_ID, 'letters, numbers, - and _ (at most 40)'),
  egLabel: plainText(LABEL_MAX_CHARS),
  egSource: pattern(EG_SOURCE, 'an event detail name like hostName'),
};

const TEXT_KEYS: Record<string, Check> = {
  ...COMMON_KEYS,
  fill: hexColour,
  text: plainText(CANVAS_TEXT_MAX_CHARS),
  fontSize: num(1, CANVAS_MAX_TEXT_UNITS),
  fontWeight,
  fontFamily,
  fontStyle: oneOf('normal', 'italic'),
  lineHeight: num(0.5, 3),
  charSpacing: num(-500, 2000),
  textAlign: oneOf('left', 'center', 'right', 'justify'),
  styles: noCharacterStyles,
  // Text on a path: Fabric writes these with their defaults; there is no
  // `path` (that key isn't allowed), so they do nothing.
  pathStartOffset: num(0, 0),
  pathSide: oneOf('left'),
  pathAlign: oneOf('baseline'),
  underline: bool,
  overline: bool,
  linethrough: bool,
  textBackgroundColor: colourOrNone,
  direction: oneOf('ltr', 'rtl'),
  textDecorationThickness: num(0, 1000),
  minWidth: num(0, SIZE_MAX),
  splitByGrapheme: bool,
};

const IMAGE_KEYS: Record<string, Check> = {
  ...COMMON_KEYS,
  fill: unpaintedFill,
  // `src` is checked by the caller (it must be one of this event's design
  // images); listed so it isn't refused as unknown.
  src: () => undefined,
  crossOrigin: oneOf(null, '', 'anonymous'),
  filters: emptyArray,
  cropX: num(0, SIZE_MAX),
  cropY: num(0, SIZE_MAX),
};

const RECT_KEYS: Record<string, Check> = {
  ...COMMON_KEYS,
  fill: colourOrNone,
  rx: num(0, SIZE_MAX),
  ry: num(0, SIZE_MAX),
};

const CIRCLE_KEYS: Record<string, Check> = {
  ...COMMON_KEYS,
  fill: colourOrNone,
  radius: num(0, SIZE_MAX),
  startAngle: num(0, 360),
  endAngle: num(0, 360),
  counterClockwise: bool,
};

const LINE_KEYS: Record<string, Check> = {
  ...COMMON_KEYS,
  fill: unpaintedFill,
  x1: num(-COORD_MAX, COORD_MAX),
  y1: num(-COORD_MAX, COORD_MAX),
  x2: num(-COORD_MAX, COORD_MAX),
  y2: num(-COORD_MAX, COORD_MAX),
};

const RSVP_BUTTON_KEYS: Record<string, Check> = {
  ...COMMON_KEYS,
  fill: unpaintedFill,
  egRole: oneOf('rsvpButton'),
  // Checked by the caller, child by child.
  objects: () => undefined,
  subTargetCheck: bool,
  interactive: bool,
  layoutManager: (value, where, key) => {
    if (!isObj(value) || Object.keys(value).length !== 2 || value['type'] !== 'layoutManager' || value['strategy'] !== 'fit-content') {
      throw documentInvalid(`${where}: '${key}' must be Fabric's default { type: 'layoutManager', strategy: 'fit-content' }.`);
    }
  },
};

const KEYS_BY_TYPE: Record<string, Record<string, Check>> = {
  Textbox: TEXT_KEYS,
  Image: IMAGE_KEYS,
  Rect: RECT_KEYS,
  Circle: CIRCLE_KEYS,
  Line: LINE_KEYS,
};
// Inside the RSVP button: shapes and its label, never an image or a group.
const RSVP_CHILD_TYPES = new Set(['Textbox', 'Rect', 'Circle', 'Line']);

const DOCUMENT_KEYS = new Set(['version', 'objects', 'background', 'backgroundImage']);

// ── Images ────────────────────────────────

export interface CanvasImageContext {
  cloudName: string;
  tenantId: string;
  eventId: string;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The public id of one of THIS event's design images, from its Cloudinary
// delivery URL (`https://res.cloudinary.com/<our cloud>/image/upload/v<n>/
// <env>/t/<tenant>/e/<event>/design-asset/<uuid>.<ext>`), or null for any
// other URL: another account, another event's folder, a transformation, a
// query string, a data: or javascript: URL.
export const designAssetPublicIdFromUrl = (url: unknown, ctx: CanvasImageContext): string | null => {
  if (typeof url !== 'string') return null;
  const match = new RegExp(
    `^https://res\\.cloudinary\\.com/${escapeRegExp(ctx.cloudName)}/image/upload/(?:v\\d+/)?([^?#\\s]+)\\.(?:webp|jpg|jpeg|png)$`
  ).exec(url);
  const publicId = match?.[1];
  return publicId && isSignedPublicIdInFolder(publicId, designAssetFolder(ctx.tenantId, ctx.eventId)) ? publicId : null;
};

// A Cloudinary image delivery URL's public id (any account, any folder),
// or null: for a STORED document, whose URLs were checked when it was saved.
export const cloudinaryImagePublicId = (url: string): string | null =>
  /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:v\d+\/)?([^?#\s]+)\.[A-Za-z0-9]+$/.exec(url)?.[1] ?? null;

// Every image URL a stored document uses, once each (its images, and its
// background image). Reads a document already checked when it was saved:
// for copying its files (event-duplicate.service.ts).
export const canvasImageSources = (document: unknown): string[] => {
  if (!isObj(document)) return [];
  const sources = new Set<string>();
  const add = (obj: unknown): void => {
    if (isObj(obj) && obj['type'] === 'Image' && typeof obj['src'] === 'string') sources.add(obj['src']);
  };
  if (Array.isArray(document['objects'])) document['objects'].forEach(add);
  add(document['backgroundImage']);
  return [...sources];
};

// ── The document ──────────────────────────

export interface CheckedCanvasDocument {
  document: Obj;
  hasRsvpButton: boolean;
  // Every image URL the document uses, once each, and their public ids.
  imageUrls: string[];
  imagePublicIds: string[];
  elementCount: number;
  imageCount: number;
}

const describe = (index: number | 'background', type: unknown): string =>
  index === 'background' ? 'The background image' : `Element ${index + 1}${typeof type === 'string' ? ` (${type})` : ''}`;

export const assertValidCanvasDocument = (raw: unknown, ctx: CanvasImageContext): CheckedCanvasDocument => {
  if (!isObj(raw)) throw documentInvalid('The design must be sent as the editor\'s document: { version, objects: [...] }.');

  // Size first: bounds the work every check below can be made to do.
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (bytes > CANVAS_DOCUMENT_MAX_BYTES) {
    throw invalid(
      CODES.DOCUMENT_TOO_LARGE,
      `This design is too large to save (${Math.ceil(bytes / 1024)}KB; the limit is ${CANVAS_DOCUMENT_MAX_BYTES / 1024}KB). ` +
      'Remove some elements, and add images by uploading them rather than pasting them in.'
    );
  }

  const unknownTop = Object.keys(raw).filter((k) => !DOCUMENT_KEYS.has(k));
  if (unknownTop.length > 0) throw documentInvalid(`The design has settings that can't be saved: ${unknownTop.map((k) => `'${k}'`).join(', ')}.`);
  COMMON_KEYS['version']!(raw['version'], 'The design', 'version');
  if (raw['background'] !== undefined) hexColour(raw['background'], 'The design', 'background');
  if (!Array.isArray(raw['objects'])) throw documentInvalid("The design's 'objects' must be a list.");

  const imageUrls = new Set<string>();
  const imagePublicIds = new Set<string>();
  let elementCount = 0;
  let imageCount = 0;
  let rsvpButtons = 0;

  const countElement = (): void => {
    elementCount += 1;
    if (elementCount > CANVAS_MAX_ELEMENTS) {
      throw invalid(CODES.TOO_MANY_ELEMENTS, `A design can have at most ${CANVAS_MAX_ELEMENTS} elements. Remove some and save again.`);
    }
  };

  const checkKeys = (obj: Obj, allowed: Record<string, Check>, where: string): void => {
    const unknown = Object.keys(obj).filter((k) => !Object.prototype.hasOwnProperty.call(allowed, k) && k !== 'type');
    if (unknown.length > 0) {
      throw documentInvalid(`${where} has ${unknown.length === 1 ? 'a setting' : 'settings'} that can't be saved: ${unknown.map((k) => `'${k}'`).join(', ')}.`);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'type') allowed[key]!(value, where, key);
    }
  };

  const checkImage = (obj: Obj, where: string): void => {
    imageCount += 1;
    if (imageCount > CANVAS_MAX_IMAGES) {
      throw invalid(CODES.TOO_MANY_IMAGES, `A design can have at most ${CANVAS_MAX_IMAGES} images. Remove one and save again.`);
    }
    const publicId = designAssetPublicIdFromUrl(obj['src'], ctx);
    if (!publicId) {
      throw invalid(
        CODES.IMAGE_SOURCE_NOT_ALLOWED,
        `${where} isn't an image uploaded for this event's design. Upload it from the design editor and place it again.`
      );
    }
    imageUrls.add(obj['src'] as string);
    imagePublicIds.add(publicId);
  };

  // The size a text is drawn at, in canvas units: never under the minimum.
  const checkTextSize = (obj: Obj, where: string, parentScaleY: number): void => {
    const drawn = (obj['fontSize'] as number) * ((obj['scaleY'] as number | undefined) ?? 1) * parentScaleY;
    if (drawn < CANVAS_MIN_TEXT_UNITS) {
      throw invalid(
        CODES.TEXT_TOO_SMALL,
        `${where} is too small to read on a phone (${Math.round(drawn * 10) / 10}). Text must be at least ${CANVAS_MIN_TEXT_UNITS}.`
      );
    }
  };

  const checkElement = (value: unknown, where: string, inRsvpButton: { scaleY: number } | null): void => {
    if (!isObj(value)) throw documentInvalid(`${where} must be an object.`);
    countElement();
    const type = value['type'];

    if (type === 'Group') {
      if (inRsvpButton) throw invalid(CODES.ELEMENT_NOT_ALLOWED, `${where}: the RSVP button can't contain a group.`);
      if (value['egRole'] !== 'rsvpButton') {
        throw invalid(CODES.ELEMENT_NOT_ALLOWED, `${where}: groups aren't supported, except the RSVP button.`);
      }
      rsvpButtons += 1;
      if (rsvpButtons > 1) throw invalid(CODES.RSVP_BUTTON_DUPLICATE, 'A design can have only one RSVP button. Remove the extra one and save again.');
      checkKeys(value, RSVP_BUTTON_KEYS, where);
      const children = value['objects'];
      if (!Array.isArray(children) || children.length === 0 || children.length > RSVP_BUTTON_MAX_CHILDREN) {
        throw documentInvalid(`${where}: the RSVP button must hold between 1 and ${RSVP_BUTTON_MAX_CHILDREN} shapes and its label.`);
      }
      if (!children.some((c) => isObj(c) && c['type'] === 'Textbox')) {
        throw documentInvalid(`${where}: the RSVP button needs a label.`);
      }
      const scaleY = (value['scaleY'] as number | undefined) ?? 1;
      children.forEach((child, i) => checkElement(child, `${where}, part ${i + 1}`, { scaleY }));
      return;
    }

    if (typeof type !== 'string' || !KEYS_BY_TYPE[type] || (inRsvpButton && !RSVP_CHILD_TYPES.has(type))) {
      throw invalid(
        CODES.ELEMENT_NOT_ALLOWED,
        `${where}: '${typeof type === 'string' ? type.slice(0, 40) : String(type)}' isn't an element a design can have. ` +
        'Use text, images, rectangles, circles, lines and the RSVP button.'
      );
    }
    if (value['egRole'] !== undefined) throw documentInvalid(`${where}: only the RSVP button has a role.`);
    checkKeys(value, KEYS_BY_TYPE[type]!, where);
    if (type === 'Textbox') {
      if (typeof value['fontSize'] !== 'number') throw documentInvalid(`${where}: 'fontSize' is required.`);
      if (typeof value['fontFamily'] !== 'string') throw invalid(CODES.FONT_NOT_ALLOWED, `${where}: a font is required.`);
      checkTextSize(value, where, inRsvpButton?.scaleY ?? 1);
    }
    if (type === 'Image') checkImage(value, where);
  };

  (raw['objects'] as unknown[]).forEach((obj, i) => checkElement(obj, describe(i, isObj(obj) ? obj['type'] : undefined), null));

  if (raw['backgroundImage'] !== undefined && raw['backgroundImage'] !== null) {
    const bg = raw['backgroundImage'];
    if (!isObj(bg) || bg['type'] !== 'Image') throw invalid(CODES.ELEMENT_NOT_ALLOWED, 'The background must be a colour or an image.');
    countElement();
    checkKeys(bg, IMAGE_KEYS, describe('background', 'Image'));
    checkImage(bg, describe('background', 'Image'));
  }

  return {
    document: raw,
    hasRsvpButton: rsvpButtons === 1,
    imageUrls: [...imageUrls],
    imagePublicIds: [...imagePublicIds],
    elementCount,
    imageCount,
  };
};
