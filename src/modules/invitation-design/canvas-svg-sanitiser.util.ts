import createDOMPurify, { type Config, type DOMPurify, type UponSanitizeAttributeHookEvent } from 'dompurify';
import { JSDOM } from 'jsdom';
import { HttpError } from '../../shared/errors/http-error.js';
import {
  CANVAS_ERROR_CODES as CODES,
  CANVAS_FONT_ALLOWLIST,
  CANVAS_FORMATS,
  CANVAS_SVG_INPUT_MAX_BYTES,
  CANVAS_SVG_MAX_BYTES,
  CANVAS_WIDTH,
  type CanvasFormat,
} from './canvas-design.constants.js';

// ─────────────────────────────────────────
//  CLEANING A DESIGN'S SVG (STEERING "Invitation designs")
//
//  The SVG a browser sends is untrusted: it is shown inline on every
//  guest's invitation page, so anything it can carry (script, an event
//  handler, a link, a stylesheet, a remote resource) would run or load on
//  that page. It is cleaned here, before it is stored, by DOMPurify (on a
//  jsdom window) configured as an ALLOWLIST, plus this module's own checks
//  on every attribute value it keeps.
//
//  Parsed with the HTML parser (DOMPurify's default), the parser the guest
//  page uses when it puts the SVG inline, so what is checked is what the
//  page will build. That parser never reads a DOCTYPE's entity declarations
//  (no entity expansion, no external entity), and everything outside the
//  one root <svg> is dropped: that is where a DOCTYPE or a broken tag leaves
//  text behind.
//
//  Kept:
//    elements    svg, g, defs, clipPath, linearGradient, radialGradient,
//                stop, rect, circle, ellipse, line, polyline, polygon, path,
//                text, tspan, image (and text inside them). KEEP_CONTENT is
//                off, so a removed element goes with everything inside it
//                (a foreignObject's HTML, a script's text).
//    attributes  geometry, paint and text attributes (ATTRIBUTES below),
//                each value checked against a strict grammar: no url()
//                except a reference to an id in the same SVG (a clip path,
//                a gradient), no backslashes or quotes, transforms only as
//                matrix/translate/scale/rotate/skew with numbers;
//                `style` only as known paint and text properties with the
//                same values; `font-family` only one of the ten fonts;
//                `href` / `xlink:href` only on <image>, and only one of
//                this design's own images (its document's, already checked
//                to be this event's Cloudinary files); `data-evelope-action`
//                only as "rsvp", only on a <g>.
//  Never kept: script, style, foreignObject, use, a, iframe, animation
//  elements (animate, set, ...), every event handler (on*), any other link
//  or external reference, javascript: and data: URLs, @font-face or any
//  font URL (there is no element or property that could hold one).
//
//  Stripping something is not a refusal: the cleaned SVG is stored and the
//  KINDS stripped are logged (never the content). A refusal is only for
//  what makes the card unusable: no single <svg>, the wrong viewBox, too
//  large, or an RSVP button the document and the SVG disagree about.
// ─────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const ALLOWED_TAGS = [
  '#text',
  'svg', 'g', 'defs', 'clippath', 'lineargradient', 'radialgradient', 'stop',
  'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path',
  'text', 'tspan', 'image',
];

// Lowercase: DOMPurify compares lowercased names in an HTML document.
const ATTRIBUTES = [
  // the root
  'xmlns', 'xmlns:xlink', 'version', 'viewbox', 'preserveaspectratio', 'xml:space',
  // any element
  'id', 'transform', 'style', 'opacity', 'visibility',
  // geometry
  'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points', 'd', 'dx', 'dy',
  // paint
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'paint-order', 'vector-effect',
  'clip-path', 'clip-rule', 'clippathunits',
  // gradients
  'gradientunits', 'gradienttransform', 'spreadmethod', 'offset', 'fx', 'fy', 'fr', 'stop-color', 'stop-opacity',
  // text
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor', 'dominant-baseline',
  'letter-spacing', 'word-spacing', 'text-decoration',
  // images: their link is checked by the hook
  'href', 'xlink:href',
  // the RSVP button's group
  'data-evelope-action',
];

// Numbers, keywords, colours as #hex, lengths and lists: no parentheses,
// quotes, backslashes, colons or semicolons, so nothing that could be a
// URL, a function or another declaration.
const SAFE_VALUE = /^[A-Za-z0-9#%.,+\- ]*$/;
const LOCAL_REF = /^url\(\s*#[A-Za-z_][\w.-]{0,63}\s*\)$/;
const RGB = /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*)?\)$/;
const TRANSFORM = /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*[-+0-9.eE,\s]*\)\s*,?)*\s*$/;
const ID = /^[A-Za-z_][\w.-]{0,63}$/;
const FONTS: ReadonlySet<string> = new Set(CANVAS_FONT_ALLOWLIST);

const isPaint = (value: string): boolean => SAFE_VALUE.test(value) || LOCAL_REF.test(value) || RGB.test(value);
const isFont = (value: string): boolean => FONTS.has(value.trim().replace(/^(['"])(.*)\1$/, '$2'));

// What each kept attribute's value may be. Not listed: SAFE_VALUE.
const VALUE_RULES: Record<string, (value: string, tag: string) => boolean> = {
  xmlns: (v) => v === SVG_NS,
  'xmlns:xlink': (v) => v === XLINK_NS,
  id: (v) => ID.test(v),
  transform: (v) => TRANSFORM.test(v),
  gradienttransform: (v) => TRANSFORM.test(v),
  fill: isPaint,
  stroke: isPaint,
  'stop-color': isPaint,
  'clip-path': (v) => v === 'none' || LOCAL_REF.test(v),
  'font-family': isFont,
  'data-evelope-action': (v, tag) => tag === 'g' && v === 'rsvp',
};

// The CSS properties a `style` may set (Fabric writes its paint and text
// properties there), each with the same value rules as the attribute.
const STYLE_RULES: Record<string, (value: string) => boolean> = {
  fill: isPaint,
  stroke: isPaint,
  'stop-color': isPaint,
  'clip-path': (v) => v === 'none' || LOCAL_REF.test(v),
  'font-family': isFont,
  ...Object.fromEntries([
    'fill-opacity', 'fill-rule', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'paint-order', 'vector-effect', 'clip-rule',
    'opacity', 'visibility', 'stop-opacity', 'font-size', 'font-style', 'font-weight', 'text-anchor',
    'dominant-baseline', 'letter-spacing', 'word-spacing', 'text-decoration', 'text-decoration-thickness', 'white-space',
  ].map((p) => [p, (v: string) => SAFE_VALUE.test(v)])),
};

// Removed without being worth a log line: the wrapper DOMPurify parses
// into, Fabric's own <desc>, and the comment its XML declaration becomes.
const UNREMARKABLE = new Set(['element:body', 'element:desc', 'element:#comment']);

// A kind for the log: a tag or attribute NAME, never a value, reduced to
// safe characters. Every event handler is one kind.
const kindOf = (prefix: string, name: string): string => {
  const safe = name.toLowerCase().replace(/[^a-z0-9:#_-]/g, '').slice(0, 40) || 'unnamed';
  return `${prefix}:${prefix === 'attribute' && safe.startsWith('on') ? 'on*' : safe}`;
};

// ── One DOMPurify, reused (sanitize is synchronous, so the per-call state
//    below is never shared between two cleanings) ──

let purifier: DOMPurify | null = null;
let current: { allowedImageUrls: ReadonlySet<string>; stripped: Set<string> } | null = null;

const filterStyle = (style: string, stripped: Set<string>): string | null => {
  const kept: string[] = [];
  let dropped = false;
  for (const declaration of style.split(';')) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(':');
    const property = colon > 0 ? declaration.slice(0, colon).trim().toLowerCase() : '';
    const value = colon > 0 ? declaration.slice(colon + 1).trim() : '';
    const rule = STYLE_RULES[property];
    if (rule && value && rule(value)) {
      kept.push(`${property}: ${value};`);
    } else {
      dropped = true;
      stripped.add(kindOf('style', /^[a-z-]+$/.test(property) ? property : 'other'));
    }
  }
  if (!dropped) return style;
  return kept.length > 0 ? kept.join(' ') : null;
};

const onAttribute = (node: Element, data: UponSanitizeAttributeHookEvent): void => {
  if (!current) return;
  const tag = node.nodeName.toLowerCase();
  const name = data.attrName;
  const value = data.attrValue;

  if (name === 'href' || name === 'xlink:href') {
    data.keepAttr = tag === 'image' && current.allowedImageUrls.has(value);
    return;
  }
  if (name === 'style') {
    const filtered = filterStyle(value, current.stripped);
    if (filtered === null) data.keepAttr = false;
    else data.attrValue = filtered;
    return;
  }
  const rule = VALUE_RULES[name];
  data.keepAttr = rule ? rule(value, tag) : SAFE_VALUE.test(value);
};

const getPurifier = (): DOMPurify => {
  if (purifier) return purifier;
  const purify = createDOMPurify(new JSDOM('').window as unknown as Parameters<typeof createDOMPurify>[0]);
  purify.addHook('uponSanitizeAttribute', onAttribute);
  purifier = purify;
  return purify;
};

const CONFIG: Config & { RETURN_DOM: true } = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: ATTRIBUTES,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: false,
  RETURN_DOM: true,
  // Belt and braces: never kept whatever the lists above say.
  FORBID_TAGS: ['script', 'style', 'foreignobject', 'use', 'a', 'iframe', 'animate', 'animatemotion', 'animatetransform', 'set', 'mpath', 'discard', 'feimage', 'filter', 'pattern', 'mask', 'marker', 'symbol', 'switch', 'title', 'metadata'],
};

// ── The cleaning ──────────────────────────

export interface CleanedSvg {
  svg: string;
  // The kinds removed (`element:script`, `attribute:on*`, `style:fill`),
  // empty when nothing security-relevant was. Names only, never content.
  stripped: string[];
}

export interface CleanSvgOptions {
  format: CanvasFormat;
  // The design's own image URLs (its document's, already checked): the
  // only links an <image> may keep.
  allowedImageUrls: ReadonlySet<string>;
  // Whether the document has an RSVP button: the SVG must then mark its
  // group (data-evelope-action="rsvp") exactly once, and otherwise never.
  hasRsvpButton: boolean;
}

const invalid = (code: string, message: string): HttpError => new HttpError(422, message, code);

const viewBoxMatches = (svg: Element, format: CanvasFormat): boolean => {
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts[0] === 0 && parts[1] === 0 && parts[2] === CANVAS_WIDTH && parts[3] === CANVAS_FORMATS[format];
};

export const cleanCanvasSvg = (raw: unknown, options: CleanSvgOptions): CleanedSvg => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalid(CODES.SVG_INVALID, "The design's picture (its SVG) is missing. Save it again from the editor.");
  }
  if (Buffer.byteLength(raw, 'utf8') > CANVAS_SVG_INPUT_MAX_BYTES) {
    throw invalid(CODES.SVG_TOO_LARGE, `This design's picture is too large to save (the limit is ${CANVAS_SVG_MAX_BYTES / 1024}KB). Remove some elements and save again.`);
  }

  const purify = getPurifier();
  const stripped = new Set<string>();
  current = { allowedImageUrls: options.allowedImageUrls, stripped };
  let body: Node;
  try {
    body = purify.sanitize(raw, CONFIG);
  } finally {
    current = null;
  }
  for (const removed of purify.removed) {
    if ('element' in removed && removed.element) stripped.add(kindOf('element', removed.element.nodeName));
    else if ('attribute' in removed) stripped.add(kindOf('attribute', removed.attribute?.name ?? 'unnamed'));
  }

  // Exactly one root <svg>; anything beside it (text a DOCTYPE or a broken
  // tag left behind) is dropped.
  const roots: Element[] = [];
  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === 1 && (child as Element).namespaceURI === SVG_NS && child.nodeName.toLowerCase() === 'svg') {
      roots.push(child as Element);
    } else if (child.nodeType === 1) {
      stripped.add('element:outside-svg');
    } else if (child.nodeType === 3 && (child.textContent ?? '').trim()) {
      stripped.add('text:outside-svg');
    }
  }
  if (roots.length !== 1) {
    throw invalid(CODES.SVG_INVALID, "The design's picture isn't a single SVG image. Save it again from the editor.");
  }
  const svg = roots[0]!;

  if (!viewBoxMatches(svg, options.format)) {
    throw invalid(
      CODES.SVG_VIEWBOX_MISMATCH,
      `The design's picture must be ${CANVAS_WIDTH} by ${CANVAS_FORMATS[options.format]} (viewBox "0 0 ${CANVAS_WIDTH} ${CANVAS_FORMATS[options.format]}") for the ${options.format} format.`
    );
  }

  const markers = svg.querySelectorAll('[data-evelope-action]').length;
  if (markers !== (options.hasRsvpButton ? 1 : 0)) {
    throw invalid(
      CODES.SVG_RSVP_MISMATCH,
      options.hasRsvpButton
        ? "The design has an RSVP button, but its picture doesn't mark it. Save it again from the editor."
        : "The design's picture marks an RSVP button the design doesn't have. Save it again from the editor."
    );
  }

  const cleaned = svg.outerHTML;
  const bytes = Buffer.byteLength(cleaned, 'utf8');
  if (bytes > CANVAS_SVG_MAX_BYTES) {
    throw invalid(
      CODES.SVG_TOO_LARGE,
      `This design's picture is too large to save (${Math.ceil(bytes / 1024)}KB; the limit is ${CANVAS_SVG_MAX_BYTES / 1024}KB). Remove some elements and save again.`
    );
  }

  return { svg: cleaned, stripped: [...stripped].filter((k) => !UNREMARKABLE.has(k)).sort() };
};
